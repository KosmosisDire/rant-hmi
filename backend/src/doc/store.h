/* File IO for the authored artifact: whole-file read, and a write that lands
 * atomically (temp file in the same directory, then rename over the target) so a
 * crash mid-write can never truncate a document. */
#pragma once

#include <string>

namespace hmi {

bool read_file(const std::string& path, std::string& out, std::string& err);
bool write_file_atomic(const std::string& path, const std::string& data, std::string& err);

} // namespace hmi
