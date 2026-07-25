#!/bin/sh
# Build a standalone .deb for a LiteAdmin plugin.
#
#   packaging/build-plugin.sh <plugin-name> <version> [output-dir]
#
# Plugins live in src/plugins/<name>/. The core package excludes that directory,
# so a plugin is shipped as its own .deb: this installs src/plugins/<name>/ into
# /usr/share/liteadmin/plugins/<name>/ and depends on the liteadmin package.
set -eu

name="${1:?usage: build-plugin.sh <plugin-name> <version> [output-dir]}"
version="${2:?usage: build-plugin.sh <plugin-name> <version> [output-dir]}"
outdir="$(cd "${3:-.}" && pwd)"

cd "$(dirname "$0")/.."
. packaging/lib.sh

src="src/plugins/$name"
control="packaging/$name/control"
[ -d "$src" ] || { echo "no such plugin: $src" >&2; exit 1; }
[ -f "$control" ] || { echo "no control file: $control" >&2; exit 1; }

stage="$(mktemp -d)/$name"
root="$stage/usr/share/liteadmin/plugins/$name"
mkdir -p "$stage/DEBIAN" "$root"
cp -r "$src/." "$root/"

# A plugin's own database lives in /var/lib/liteadmin/data/<name>/ at runtime;
# a copy from the developer's tree must not be shipped as package content.
find "$root" -name '*.sqlite' -delete
deb_scrub "$root"

for script in preinst postinst prerm postrm; do
    if [ -f "packaging/$name/$script" ]; then
        install -m 755 "packaging/$name/$script" "$stage/DEBIAN/$script"
    fi
done

deb_normalize "$stage"
deb_md5sums   "$stage"
deb_control   "$stage" "$control" "$version"
deb_build     "$stage" "$outdir/${name}_${version}_all.deb"
