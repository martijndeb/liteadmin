#!/bin/sh
# Sanity-check built LiteAdmin .debs before they are published.
#
#   packaging/verify-deb.sh liteadmin_1.2.3_all.deb [more.deb ...]
#
# Guards three classes of mistake that stay invisible until someone installs the
# package: shipping files that should never leave the working tree, shipping
# unsafe modes, and pruning a vendored asset the app actually loads at runtime.
set -eu

failures="$(mktemp)"
trap 'rm -f "$failures"' EXIT

note() { echo "  $1"; }
bad()  { echo "  FAIL: $1" >&2; echo x >> "$failures"; }

# Files the app requests from the vendored Monaco build. packaging/build-core.sh
# deletes the languages and locales around these; if a prune ever takes one of
# them with it the editor breaks in the browser and nowhere else -- so assert
# them here, where a release build can still fail.
CORE_REQUIRED="
index.php
index.html
lib.php
plugin.php
plugins.php
proxy.php
.htaccess
js/app.js
css/app.css
i18n/en.json
vendor/vs/loader.js
vendor/vs/editor/editor.main.js
vendor/vs/editor/editor.main.css
vendor/vs/editor/editor.main.nls.js
vendor/vs/basic-languages/sql/sql.js
vendor/vs/language/json/jsonMode.js
vendor/vs/language/json/jsonWorker.js
vendor/vs/base/worker/workerMain.js
"

# Runtime state, local overrides, separately-packaged content, and the vendored
# language services that build-core.sh is expected to have pruned.
CORE_FORBIDDEN="
config.json
config.local.json
databases
data
plugins
vendor/vs/language/typescript
vendor/vs/language/css
vendor/vs/language/html
"

check_core() {
    listing="$1"
    for f in $CORE_REQUIRED; do
        grep -qxF "usr/share/liteadmin/$f" "$listing" || bad "missing $f"
    done
    for f in $CORE_FORBIDDEN; do
        grep -qE "^usr/share/liteadmin/$f(/|\$)" "$listing" && bad "ships $f"
    done
    # Localized editor bundles: only the default one is loaded.
    locales="$(grep -c 'editor\.main\.nls\..*\.js$' "$listing" || true)"
    [ "$locales" = 0 ] || bad "ships $locales unused editor locale bundles"
    # Syntax definitions: sql only.
    langs="$(grep -c '^usr/share/liteadmin/vendor/vs/basic-languages/[^/]*/' "$listing" || true)"
    [ "$langs" -le 2 ] || bad "unpruned basic-languages ($langs entries)"
    return 0
}

check_plugin() {
    name="$1"; listing="$2"
    strays="$(grep -vE "^usr(/share(/liteadmin(/plugins(/$name(/.*)?)?)?)?)?\$" "$listing" || true)"
    [ -z "$strays" ] || bad "$name ships paths outside plugins/$name: $(echo "$strays" | tr '\n' ' ')"
    return 0
}

for deb in "$@"; do
    echo "$(basename "$deb")"
    work="$(mktemp -d)"
    dpkg-deb -x "$deb" "$work/root"
    dpkg-deb -e "$deb" "$work/root/DEBIAN"

    # Modes and ownership: nothing world-writable, nothing setuid/setgid,
    # everything owned by root.
    dpkg-deb -c "$deb" | awk '
        substr($1, 9, 1) == "w"                       { print "world-writable: " $NF }
        substr($1, 4, 1) ~ /[sS]/                     { print "setuid: "         $NF }
        substr($1, 7, 1) ~ /[sS]/                     { print "setgid: "         $NF }
        $2 != "root/root"                             { print "not root-owned: " $NF }
    ' > "$work/modes"
    while read -r problem; do
        [ -n "$problem" ] && bad "$problem"
    done < "$work/modes"

    # md5sums must exist and match the payload, so `dpkg -V` and debsums can
    # verify the installed files later on.
    if [ -f "$work/root/DEBIAN/md5sums" ]; then
        ( cd "$work/root" && md5sum -c --quiet DEBIAN/md5sums >/dev/null ) \
            || bad "md5sums do not match the payload"
        listed="$(grep -c . "$work/root/DEBIAN/md5sums")"
        actual="$(find "$work/root" -path "$work/root/DEBIAN" -prune -o -type f -print | grep -c .)"
        [ "$listed" = "$actual" ] || bad "md5sums lists $listed files, package ships $actual"
    else
        bad "no DEBIAN/md5sums"
    fi

    for field in Package Version Architecture Maintainer Description Installed-Size; do
        grep -q "^$field:" "$work/root/DEBIAN/control" || bad "control has no $field"
    done

    ( cd "$work/root" && find . -path ./DEBIAN -prune -o -print ) \
        | sed 's|^\./||' | grep -v '^\.$' | grep -v '^$' | LC_ALL=C sort > "$work/listing"

    # Never ship a database, whatever the package.
    grep -qE '\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$' "$work/listing" \
        && bad "ships a database file"

    case "$(basename "$deb")" in
        liteadmin_*) check_core   "$work/listing" ;;
        *)           check_plugin "$(basename "$deb" | cut -d_ -f1)" "$work/listing" ;;
    esac

    note "$(du -h "$deb" | cut -f1) archive, $(grep -c . "$work/listing") entries, \
installs $(awk -F': ' '/^Installed-Size:/ {print $2}' "$work/root/DEBIAN/control") KiB"
    rm -rf "$work"
done

if [ -s "$failures" ]; then
    echo "package verification failed" >&2
    exit 1
fi
echo "all packages verified"
