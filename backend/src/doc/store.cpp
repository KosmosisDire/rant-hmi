#include "store.h"

#include <cstdio>
#include <fstream>
#include <sstream>

namespace hmi {

bool read_file(const std::string& path, std::string& out, std::string& err) {
    std::ifstream in(path, std::ios::binary);
    if (!in) { err = "cannot open " + path; return false; }
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

bool write_file_atomic(const std::string& path, const std::string& data, std::string& err) {
    const std::string tmp = path + ".tmp";
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) { err = "cannot write " + tmp; return false; }
        out.write(data.data(), static_cast<std::streamsize>(data.size()));
        out.flush();
        if (!out) { err = "write failed for " + tmp; return false; }
    }
    /* rename() will not replace an existing file on Windows; remove first. The
     * window this opens is why the temp file is the durable copy until now. */
    std::remove(path.c_str());
    if (std::rename(tmp.c_str(), path.c_str()) != 0) {
        err = "cannot rename " + tmp + " over " + path;
        return false;
    }
    return true;
}

} // namespace hmi
