# Applied to the extracted IXWebSocket source by FetchContent PATCH_COMMAND. Idempotent.

# Server sends never block: on Windows a flush from the logic thread cancels the connection
# thread's read registration, and the server never reads that socket again.
file(READ "ixwebsocket/IXWebSocketTransport.cpp" _src)
string(REPLACE "_blockingSend = true;" "_blockingSend = false;" _patched "${_src}")
file(WRITE "ixwebsocket/IXWebSocketTransport.cpp" "${_patched}")

# No wsock32: linked ahead of ws2_32 it takes Rant's socket calls, and its WinSock 1
# setsockopt reads IP_MULTICAST_IF wrong, so LAN peers stay unknown.
file(READ "CMakeLists.txt" _src)
string(REPLACE "PRIVATE wsock32 ws2_32 shlwapi" "PRIVATE ws2_32 shlwapi" _patched "${_src}")
file(WRITE "CMakeLists.txt" "${_patched}")
