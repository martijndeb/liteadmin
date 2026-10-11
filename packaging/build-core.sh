#!/bin/sh
# Build the core LiteAdmin .deb.
#
#   packaging/build-core.sh <version> [output-dir]
#
# Ships src/ to /usr/share/liteadmin, minus:
#   - runtime state (databases/, data/, config.json) -- postinst symlinks those
#     to /var/lib/liteadmin and /etc/liteadmin,
#   - plugins/, since every plugin is its own .deb (see build-plugin.sh),
#   - the vendored editor assets the app never loads (see prune_vendor).
set -eu

version="${1:?usage: build-core.sh <version> [output-dir]}"
outdir="$(cd "${2:-.}" && pwd)"
cd "$(dirname "$0")/.."
. packaging/lib.sh

# prune_vendor <vs-dir>
# Monaco (0.57) is vendored as its full AMD `min/vs` distribution: ~25 MB, of which
# the app loads a fraction. editor.main.js only references the per-language worker
# URLs (assets/*.worker-*.js); a worker is fetched when a model of that language
# is created. LiteAdmin creates 'sql' and 'json' models only, so the TypeScript,
# CSS and HTML workers and their language/* re-export shims are dead weight. The
# UI locale is set from the app language (src/js/editor.js); Monaco ships no
# nl/fy/sv bundle, so only de survives.
#
# packaging/verify-deb.sh asserts that everything the app does load survived, so
# a bad edit here or a future re-vendoring fails the release build rather than
# 404ing in someone's browser.
prune_vendor() {
    vs="$1"
    [ -d "$vs" ] || return 0
    rm -rf "$vs/language/typescript" "$vs/language/css" "$vs/language/html"
    rm -f "$vs"/assets/ts.worker-*.js "$vs"/assets/css.worker-*.js "$vs"/assets/html.worker-*.js
    find "$vs/nls/lang" -type f ! -name de.js -delete
}

stage="$(mktemp -d)/liteadmin"
root="$stage/usr/share/liteadmin"
mkdir -p "$stage/DEBIAN" "$root"
cp -r src/. "$root/"

# Runtime state: created and owned by postinst, never shipped.
rm -rf "$root/databases" "$root/data" "$root/config.json" "$root/config.local.json"
# Plugins ship separately.
rm -rf "$root/plugins"
# Loadable SQLite extensions are dropped in by the admin at runtime; a binary
# sitting in a developer's src/ext/ must not ride along into the package. The
# .htaccess deny rule does ship, so the directory is never web-readable.
find "$root/ext" -mindepth 1 ! -name .gitkeep ! -name .htaccess -exec rm -rf {} + 2>/dev/null || true

prune_vendor "$root/vendor/vs"
deb_scrub "$root"

install -m 755 packaging/postinst "$stage/DEBIAN/postinst"
install -m 755 packaging/postrm   "$stage/DEBIAN/postrm"

deb_normalize "$stage"
deb_md5sums   "$stage"
deb_control   "$stage" packaging/control "$version"
deb_build     "$stage" "$outdir/liteadmin_${version}_all.deb"
