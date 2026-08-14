/* THE TOMBSTONE TEST: dead symbols stay dead. Reads the burial list
 * (tests/tombstones.txt), scans every source tree for each symbol as a plain
 * substring, and fails on any hit with the file and line. The list grows in the
 * same commit that deletes a symbol; this test is what keeps a later change from
 * quietly reintroducing an old path (the language-rewrite plan, stage 0). */
#include "check.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

bool scanned_kind(const fs::path& file) {
    const std::string ext = file.extension().string();
    return ext == ".h" || ext == ".cpp" || ext == ".ts" || ext == ".mjs";
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: tombstone_test <repo-root> <tombstones.txt>\n");
        return 2;
    }
    const fs::path root = argv[1];

    std::vector<std::string> symbols;
    {
        std::ifstream list(argv[2]);
        if (!CHECK_MSG(list.good(), std::string("cannot read ") + argv[2]))
            return check::summary("tombstone_test");
        std::string line;
        while (std::getline(list, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
                line.pop_back();
            if (line.empty() || line[0] == '#') continue;
            symbols.push_back(line);
        }
    }

    const char* trees[] = {"backend/src", "backend/tests", "frontend/src",
                           "frontend/test", "tools"};
    size_t files = 0;
    for (const char* tree : trees) {
        const fs::path base = root / tree;
        if (!fs::exists(base)) continue;
        for (const auto& entry : fs::recursive_directory_iterator(base)) {
            if (!entry.is_regular_file() || !scanned_kind(entry.path())) continue;
            if (entry.path().filename() == "tombstones.txt") continue;
            ++files;
            if (symbols.empty()) continue;
            std::ifstream in(entry.path(), std::ios::binary);
            std::string line;
            size_t line_no = 0;
            while (std::getline(in, line)) {
                ++line_no;
                for (const std::string& symbol : symbols) {
                    if (line.find(symbol) == std::string::npos) continue;
                    std::ostringstream note;
                    note << "dead symbol '" << symbol << "' resurrected at "
                         << entry.path().generic_string() << ":" << line_no;
                    CHECK_MSG(false, note.str());
                }
            }
        }
    }
    CHECK_MSG(files > 100, "scanned suspiciously few files; wrong repo root?");
    std::printf("tombstone_test: %zu symbols over %zu files\n", symbols.size(), files);
    return check::summary("tombstone_test");
}
