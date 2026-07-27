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

# nlohmann/json, header-only: the document and the control plane (never the tick).
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install    OFF CACHE INTERNAL "")
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(nlohmann_json)

# One static lib holds every module: the modules are separate translation units and
# the dependency direction is enforced by what each file includes (PLAN.md).
add_library(hmi_core STATIC
  src/doc/schema.cpp
  src/doc/doc.cpp
  src/doc/ops.cpp
  src/doc/refs.cpp
  src/doc/store.cpp
)
target_include_directories(hmi_core PUBLIC src)
target_link_libraries(hmi_core PUBLIC nlohmann_json::nlohmann_json)

find_package(Threads REQUIRED)
target_link_libraries(hmi_core PUBLIC Threads::Threads)

# pinned float behaviour: replay compares effects bit for bit within one build
if(MSVC)
  target_compile_options(hmi_core PUBLIC /fp:precise /W4)
else()
  target_compile_options(hmi_core PUBLIC -ffp-contract=off -Wall -Wextra)
endif()

enable_testing()
add_executable(hmi_doc_test tests/doc_test.cpp)
target_link_libraries(hmi_doc_test PRIVATE hmi_core)
add_test(NAME doc_test COMMAND hmi_doc_test)
