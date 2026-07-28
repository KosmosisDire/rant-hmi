/* The DART implementation anchor: exactly one TU defines DART_IMPLEMENTATION so the
 * amalgamated C library is emitted once (the C library compiles cleanly as C++; the
 * explicit define is required in a .cpp, the auto-define only fires for C). Every
 * other TU includes dart.hpp bare and gets the consumer declarations. */
#define DART_IMPLEMENTATION
#include "dart.hpp"
