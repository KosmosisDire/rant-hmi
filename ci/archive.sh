#!/bin/sh
# Packs the release build as the archive rant install unpacks: package.rant, the group, bin/
# with the backend, and client/ with the built editor it serves.
# Usage: ci/archive.sh <platform>, such as linux-x64. Writes out/rant-hmi-<version>-<platform>.tar.gz
set -e
platform=$1
version=$(sed -n 's/^version = "\(.*\)"/\1/p' server/Cargo.toml | head -1)
name="rant-hmi-$version-$platform"
# where cargo built, under the target CARGO_BUILD_TARGET names when it names one
built=target/${CARGO_BUILD_TARGET:+$CARGO_BUILD_TARGET/}release
rm -rf pkg && mkdir -p pkg/bin out
for f in "$built/rant-hmi" "$built/rant-hmi.exe"; do
  if [ -f "$f" ]; then cp "$f" pkg/bin/; fi
done
test -f pkg/bin/rant-hmi || test -f pkg/bin/rant-hmi.exe
test -f client/dist/index.html
cp -r client/dist pkg/client
cp package.rant Hmi.run pkg/
tar -czf "out/$name.tar.gz" -C pkg package.rant Hmi.run bin client
echo "out/$name.tar.gz"
