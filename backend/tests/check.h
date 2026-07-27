/* The whole test framework: a checked expression that reports where it failed and
 * keeps going, and a summary that sets the exit code (PLAN.md: no test framework). */
#pragma once

#include <cstdio>
#include <string>

namespace check {

inline int failures = 0;
inline int checks = 0;

inline bool report(bool ok, const char* expr, const char* file, int line, const std::string& note) {
    ++checks;
    if (ok) return true;
    ++failures;
    std::printf("FAIL %s:%d  %s%s%s\n", file, line, expr, note.empty() ? "" : "  ",
                note.c_str());
    return false;
}

inline int summary(const char* name) {
    std::printf("%s: %d checks, %d failed\n", name, checks, failures);
    return failures == 0 ? 0 : 1;
}

} // namespace check

#define CHECK(expr) check::report((expr), #expr, __FILE__, __LINE__, "")
#define CHECK_MSG(expr, note) check::report((expr), #expr, __FILE__, __LINE__, (note))
#define CHECK_EQ(a, b)                                                                   \
    check::report((a) == (b), #a " == " #b, __FILE__, __LINE__,                          \
                  std::string("got ") + check::show(a) + ", want " + check::show(b))

namespace check {
inline std::string show(const std::string& v) { return v; }
inline std::string show(const char* v) { return v ? v : "(null)"; }
inline std::string show(bool v) { return v ? "true" : "false"; }
template <class T> inline std::string show(const T& v) { return std::to_string(v); }
} // namespace check
