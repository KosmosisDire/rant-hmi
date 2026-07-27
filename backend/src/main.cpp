/* Config, wiring and the service loop. One process is one HMI. */
#include "app.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

namespace {

std::atomic<bool> g_quit{false};

void on_signal(int) { g_quit = true; }

void usage() {
    std::printf(
        "usage: hmi_designer [--port 7500] [--bind 127.0.0.1] [--doc hmi.json]\n"
        "                    [--statics DIR] [--no-save] [--verbose]\n"
        "  --statics DIR  serve the frontend from DIR on the same port as the sync\n"
        "                 channel, so http://host:port/ is the whole application\n"
        "  --bind 0.0.0.0 expose the HMI beyond this host (no authentication yet)\n");
}

bool arg_value(int argc, char** argv, int& i, const char* name, std::string& out) {
    if (std::strcmp(argv[i], name) != 0) return false;
    if (i + 1 >= argc) { std::fprintf(stderr, "hmi: %s needs a value\n", name); return false; }
    out = argv[++i];
    return true;
}

} // namespace

int main(int argc, char** argv) {
    hmi::AppOptions opts;
    for (int i = 1; i < argc; ++i) {
        std::string value;
        if (arg_value(argc, argv, i, "--port", value)) { opts.server.port = std::atoi(value.c_str()); continue; }
        if (arg_value(argc, argv, i, "--bind", value)) { opts.server.bind = value; continue; }
        if (arg_value(argc, argv, i, "--doc", value)) { opts.doc_path = value; continue; }
        if (arg_value(argc, argv, i, "--statics", value)) { opts.server.statics = value; continue; }
        if (!std::strcmp(argv[i], "--no-save")) { opts.persist = false; continue; }
        if (!std::strcmp(argv[i], "--verbose")) { opts.verbose = true; continue; }
        usage();
        return std::strcmp(argv[i], "--help") && std::strcmp(argv[i], "-h") ? 1 : 0;
    }

    std::setvbuf(stdout, nullptr, _IONBF, 0);
    hmi::App app(opts);
    std::string err;
    if (!app.start(err)) {
        std::fprintf(stderr, "hmi: cannot start on %s:%d: %s\n", opts.server.bind.c_str(),
                     opts.server.port, err.c_str());
        return 1;
    }
    std::printf("hmi_designer: http://%s:%d/  (document %s, version %llu)\n",
                opts.server.bind.c_str(), opts.server.port, opts.doc_path.c_str(),
                static_cast<unsigned long long>(app.document().version()));

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);
    while (!g_quit) {
        app.poll();
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    std::printf("hmi_designer: stopping\n");
    app.stop();
    return 0;
}
