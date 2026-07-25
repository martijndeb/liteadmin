#!/bin/sh
# Shared helpers for the LiteAdmin .deb builders (build-core.sh, build-plugin.sh).
#
# Everything here exists so that a package built on a developer's laptop is
# byte-for-byte comparable to one built in CI: no umask leaking into file modes,
# no editor cruft, no files that only existed in the working tree.
#
# POSIX sh only -- no bashisms, no GNU-only sed/awk constructs.

# deb_scrub <dir>
# Drop OS/editor cruft and SQLite sidecars. These are gitignored, so they only
# turn up when building from a working tree, which is exactly when a stray file
# would silently end up in a published package.
deb_scrub() {
    find "$1" \( -name '.DS_Store'  -o -name 'Thumbs.db' -o -name 'desktop.ini' \
              -o -name '*.swp'      -o -name '*~'        -o -name '*.log' \
              -o -name '*.tmp'      -o -name '*-wal'     -o -name '*-shm' \
              -o -name '*.sqlite-journal' \) -delete
}

# deb_normalize <stagedir>
# Deterministic modes: 755 directories, 644 payload, 755 maintainer scripts.
# Also clears any setuid/setgid bit inherited from the source tree.
deb_normalize() {
    find "$1" -type d -exec chmod 755 {} +
    find "$1" -type f -exec chmod 644 {} +
    for script in preinst postinst prerm postrm; do
        [ -f "$1/DEBIAN/$script" ] && chmod 755 "$1/DEBIAN/$script"
    done
    return 0
}

# deb_md5sums <stagedir>
# dpkg's per-file integrity manifest. Without it `dpkg -V` cannot tell whether
# an installed file was corrupted or tampered with, and debsums reports the
# package as unverifiable.
deb_md5sums() {
    ( cd "$1" && find . -path ./DEBIAN -prune -o -type f -print \
        | sed 's|^\./||' | LC_ALL=C sort | xargs -r md5sum > DEBIAN/md5sums )
    chmod 644 "$1/DEBIAN/md5sums"
}

# deb_control <stagedir> <control-template> <version>
# Expands __VERSION__ and fills in Installed-Size (KiB, payload only) so apt can
# report the on-disk cost before downloading.
deb_control() {
    stage="$1"; template="$2"; version="$3"
    size="$(du -ks --exclude=DEBIAN "$stage" | cut -f1)"
    sed "s/__VERSION__/$version/" "$template" \
        | awk -v s="$size" '/^Description:/ && !d { print "Installed-Size: " s; d = 1 } { print }' \
        > "$stage/DEBIAN/control"
    chmod 644 "$stage/DEBIAN/control"
}

# deb_build <stagedir> <output.deb>
# xz is the compressor here on purpose: zstd builds faster but produces .debs
# that apt on Debian 11 / Ubuntu 20.04 refuses to install, and this repo is
# published as a public apt repository.
deb_build() {
    dpkg-deb --build --root-owner-group "$1" "$2" >/dev/null
    echo "built $2 ($(du -h "$2" | cut -f1))"
}
