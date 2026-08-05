# Applied to the extracted ixwebsocket source by FetchContent PATCH_COMMAND.
#
# Server-side connections hard-set _blockingSend = true (connectToSocket), which
# makes every ws->send() from the logic thread flush the socket ITSELF: when a
# frame exceeds the kernel send buffer (the snapshot does), the logic thread sits
# in flushSendBuffer polling for writability. On Windows both that poll and the
# connection thread's read poll register interest with WSAEventSelect per call —
# and a registration from one thread CANCELS the other's. Over a real network the
# flush window is long enough that the connection thread reliably loses its
# FD_READ registration and parks forever in an infinite wait: the server never
# reads that socket again (reads-dead, writes-to-client fine — the logic thread
# keeps pushing those). Loopback flushes in microseconds, which is why the dev
# machine can never reproduce it.
#
# Non-blocking sends restore the library's own single-threaded design: the send
# buffers the frame and wakes the connection's poll thread, which is then the
# ONLY thread ever touching the socket. Runs idempotently (no-op once applied).
file(READ "ixwebsocket/IXWebSocketTransport.cpp" _src)
string(REPLACE "_blockingSend = true;" "_blockingSend = false;" _patched "${_src}")
file(WRITE "ixwebsocket/IXWebSocketTransport.cpp" "${_patched}")
