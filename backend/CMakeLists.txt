# The HMI designer backend: one process that owns the document, the compiled program
# and all mesh I/O. Dependencies are fetched exactly as ../../bridge does.

cmake_minimum_required(VERSION 3.19)
project(hmi_designer CXX)

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

include(FetchContent)

# IXWebSocket: thread-per-connection WS server; through ix::HttpServer the same port
# also serves the frontend's files. TLS and zlib off = zero transitive dependencies.
set(USE_TLS  OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(ixwebsocket
  URL https://github.com/machinezone/IXWebSocket/archive/refs/tags/v12.0.1.tar.gz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)

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
  src/doc/ops.cpp
  src/doc/refs.cpp
  src/doc/store.cpp
  # lang/: the authored language — lexer, scalar compiler, template-expression
  # compiler, and the value/IR form both tiers lower to. Depends on nothing above it;
  # vm/ and compile/ depend on IT (src/lang/emit.h is the whole seam).
  src/lang/value.cpp
  src/lang/lexer.cpp
  src/lang/expression.cpp
  src/lang/template_expr.cpp
  src/vm/program.cpp
  src/vm/state.cpp
  src/vm/vm.cpp
  src/mesh/port.cpp
  src/mesh/fake.cpp
  src/mesh/dart_mesh.cpp
  src/mesh/dart_impl.cpp
  src/compile/components.cpp
  src/compile/compiler.cpp
  src/sched/scheduler.cpp
  src/registry/registry.cpp
  src/registry/attrs.cpp
  src/sync/server.cpp
  src/app.cpp
)
# DART: the vendored single-header C++ wrapper (vendor/dart.hpp); refresh it by
# copying a newer dist/dart.hpp over it. Override HMI_DART_DIST to build against
# an un-vendored copy.
set(HMI_DART_DIST "${HMI_ROOT}/vendor" CACHE PATH "directory holding dart.hpp")
if(NOT EXISTS "${HMI_DART_DIST}/dart.hpp")
  message(FATAL_ERROR "dart.hpp not found in ${HMI_DART_DIST} (set HMI_DART_DIST)")
endif()

target_include_directories(hmi_core PUBLIC src "${HMI_DART_DIST}")
target_link_libraries(hmi_core PUBLIC nlohmann_json::nlohmann_json ixwebsocket::ixwebsocket)

find_package(Threads REQUIRED)
target_link_libraries(hmi_core PUBLIC Threads::Threads)
if(WIN32)
  target_link_libraries(hmi_core PUBLIC ws2_32 bcrypt winmm)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_libraries(hmi_core PUBLIC rt)   # shm_open for DART's SHM fast path
endif()

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

# The view's pure half (boot and sync, document mirror, attribute interpreter, sidebar
# reconciliation) is checked headlessly against a real backend; it needs `node build.mjs`
# to have run. What a widget LOOKS like is not checked here: that is a browser's
# computation, so it belongs to a Playwright drive.
find_program(NODE_EXE node)
if(NODE_EXE AND EXISTS "${HMI_ROOT}/frontend/dist/main.js")
  add_test(NAME view_test COMMAND "${NODE_EXE}" test/view_test.mjs)
  set_tests_properties(view_test PROPERTIES
                       WORKING_DIRECTORY "${HMI_ROOT}/frontend"
                       DEPENDS sync_test)
else()
  message(STATUS "frontend view_test skipped (build it with: cd frontend && npm install && node build.mjs)")
endif()
