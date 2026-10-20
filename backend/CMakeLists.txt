# The HMI designer backend: one process that owns the document, the compiled program
# and all mesh I/O.

cmake_minimum_required(VERSION 3.19)
project(hmi_designer C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_CONFIGURATION_TYPES "Release;Debug;RelWithDebInfo;MinSizeRel"
      CACHE STRING "Build configs (Release first = the default)" FORCE)
endif()

# binaries in <repo>/bin, every config sharing it
get_filename_component(HMI_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${HMI_ROOT}/bin")
foreach(_cfg ${CMAKE_CONFIGURATION_TYPES})
  string(TOUPPER "${_cfg}" _CFG)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_${_CFG} "${HMI_ROOT}/bin")
endforeach()

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/get_cpm.cmake")

# Rant at a pinned release. Pass -DCPM_rant_SOURCE=<path to Rant> to build against a working tree.
CPMAddPackage(NAME rant
  GITHUB_REPOSITORY KosmosisDire/Rant
  VERSION 0.0.31
  EXCLUDE_FROM_ALL YES)

# Static CRT to match rant_host. Before any other dependency so every object agrees.
include("${rant_SOURCE_DIR}/tools/static_runtime.cmake")

include(FetchContent)

# IXWebSocket: thread-per-connection WS server; through ix::HttpServer the same port
# also serves the frontend's files. TLS and zlib off = zero transitive dependencies.
set(USE_TLS  OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(ixwebsocket
  URL https://github.com/machinezone/IXWebSocket/archive/refs/tags/v12.0.1.tar.gz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  # server sends must be NON-blocking (patches/ixwebsocket-nonblocking-send.cmake):
  # the stock blocking mode flushes on the sender's thread, which on Windows
  # cancels the connection thread's read registration and permanently deafens the
  # server to any remote client once a frame outgrows the kernel send buffer
  PATCH_COMMAND ${CMAKE_COMMAND} -P "${CMAKE_CURRENT_SOURCE_DIR}/patches/ixwebsocket-nonblocking-send.cmake")

# nlohmann/json, header-only: the document and the control plane (never the tick).
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install    OFF CACHE INTERNAL "")
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(ixwebsocket nlohmann_json)

# One static lib holds every module: the modules are separate translation units and
# the dependency direction is enforced by what each file includes (PLAN.md).
add_library(hmi_core STATIC
  src/doc/schema.cpp
  src/doc/doc.cpp
  src/doc/decode.cpp
  src/doc/ops.cpp
  src/doc/refs.cpp
  src/doc/store.cpp
  # lang/: the authored language — lexer, scalar compiler, template-expression
  # compiler, and the value/IR form both tiers lower to. Depends on nothing above it;
  # vm/ and compile/ depend on IT (lang/module.h — the Module a compile fills — is
  # the whole seam).
  src/lang/value.cpp
  src/lang/module.cpp
  src/lang/lexer.cpp
  src/lang/parser.cpp
  src/lang/sema.cpp
  src/lang/lower.cpp
  src/lang/compile.cpp
  src/lang/tables.cpp
  src/lang/template_expr.cpp
  src/vm/program.cpp
  src/vm/state.cpp
  src/vm/vm.cpp
  src/mesh/port.cpp
  src/mesh/fake.cpp
  src/mesh/rant_mesh.cpp
  src/compile/components.cpp
  src/compile/compiler.cpp
  src/sched/scheduler.cpp
  src/registry/registry.cpp
  src/registry/attrs.cpp
  src/sync/server.cpp
  src/app.cpp
)
target_include_directories(hmi_core PUBLIC src)
target_link_libraries(hmi_core PUBLIC nlohmann_json::nlohmann_json ixwebsocket::ixwebsocket
                      rant::rant_host)
find_package(Threads REQUIRED)
target_link_libraries(hmi_core PUBLIC Threads::Threads)

# pinned float behaviour: replay compares effects bit for bit within one build
if(MSVC)
  target_compile_options(hmi_core PUBLIC /fp:precise /W4)
else()
  target_compile_options(hmi_core PUBLIC -ffp-contract=off -Wall -Wextra)
endif()

add_executable(hmi_designer src/main.cpp)
target_link_libraries(hmi_designer PRIVATE hmi_core)

enable_testing()
foreach(_test doc_test sync_test runtime_test scheduler_test mesh_test component_test)
  add_executable(hmi_${_test} tests/${_test}.cpp)
  target_link_libraries(hmi_${_test} PRIVATE hmi_core)
  add_test(NAME ${_test} COMMAND hmi_${_test})
endforeach()

# THE CONFORMANCE FIXTURES (the language-rewrite ratchet's other half): value-level
# cases in tests/fixtures/lang, expression + env -> value | refusal | fault. They pin
# the LANGUAGE, never the encoding, so they survive IR changes unchanged and will run
# in the second interpreter verbatim.
add_executable(hmi_fixture_test tests/fixture_test.cpp)
target_link_libraries(hmi_fixture_test PRIVATE hmi_core)
add_test(NAME fixture_test COMMAND hmi_fixture_test
         "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/lang")

# The view's pure half (boot and sync, document mirror, attribute interpreter, sidebar
# reconciliation) is checked headlessly against a real backend; it needs `node build.mjs`
# to have run. What a component LOOKS like is not checked here: that is a browser's
# computation, so it belongs to a Playwright drive.
find_program(NODE_EXE node)

# The IR vocabulary is GENERATED (tools/gen_ir.mjs): one table emits the C++ enums
# (src/lang/ir_ops.h) and the view's copy (frontend/src/ir.ts). This test fails when
# either checked-in file drifts from the table — regenerate, never hand-edit.
if(NODE_EXE)
  add_test(NAME ir_gen COMMAND "${NODE_EXE}" "${HMI_ROOT}/tools/gen_ir.mjs" --check)
endif()

if(NODE_EXE AND EXISTS "${HMI_ROOT}/frontend/dist/main.js")
  add_test(NAME view_test COMMAND "${NODE_EXE}" test/view_test.mjs)
  set_tests_properties(view_test PROPERTIES
                       WORKING_DIRECTORY "${HMI_ROOT}/frontend"
                       DEPENDS sync_test)
  # THE CONFORMANCE SUITE, in the SECOND executor: the same fixture files
  # fixture_test runs through the C++ VM, compiled by the view emitter
  # (hmi_fixture_test --dump) and executed by the built frontend interpreter
  # (dist/program.js). One suite pins both interpreters, forever.
  add_test(NAME lang_conformance
           COMMAND "${NODE_EXE}" test/conformance_test.mjs
                   $<TARGET_FILE:hmi_fixture_test>
                   "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/lang")
  set_tests_properties(lang_conformance PROPERTIES
                       WORKING_DIRECTORY "${HMI_ROOT}/frontend")
else()
  message(STATUS "frontend view_test skipped (build it with: cd frontend && npm install && node build.mjs)")
endif()
