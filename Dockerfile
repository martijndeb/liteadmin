# LiteAdmin — single-container image (Caddy + php-fpm 8.4)
FROM php:8.4-fpm

# Caddy web server (from its official image) + SQLite PDO driver.
# The app is vanilla PHP/JS, so there is no build step.
COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends libsqlite3-dev ca-certificates curl; \
    docker-php-ext-install pdo_sqlite; \
    rm -rf /var/lib/apt/lists/*

# sqlite-vec (https://github.com/asg017/sqlite-vec) — the vec0 vector-search extension,
# loaded for every server database via config.json below. Bump the version and both
# checksums together; they are the release's own checksums.txt values.
ARG SQLITE_VEC_VERSION=0.1.9
ARG SQLITE_VEC_SHA256_AMD64=b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7
ARG SQLITE_VEC_SHA256_ARM64=ea03d39541e478fab5974253c461e1cb5d77742f69e40cf96e3fad5bc309a37c

# Set by BuildKit/buildx: amd64 on x86_64 Linux, arm64 on Apple Silicon. Containers on a
# Mac are Linux containers, so both targets want a linux build of the extension — just a
# different machine architecture. Falls back to the build host's own arch (classic builder).
ARG TARGETARCH

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
        amd64) vec_arch=x86_64;  vec_sha="$SQLITE_VEC_SHA256_AMD64" ;; \
        arm64) vec_arch=aarch64; vec_sha="$SQLITE_VEC_SHA256_ARM64" ;; \
        *) echo "sqlite-vec: no prebuilt loadable extension for '$arch'" >&2; exit 1 ;; \
    esac; \
    tarball="sqlite-vec-${SQLITE_VEC_VERSION}-loadable-linux-${vec_arch}.tar.gz"; \
    curl -fsSL -o /tmp/sqlite-vec.tar.gz \
        "https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/${tarball}"; \
    echo "${vec_sha}  /tmp/sqlite-vec.tar.gz" | sha256sum -c -; \
    mkdir -p /var/www/liteadmin/src/ext; \
    tar -xzf /tmp/sqlite-vec.tar.gz -C /var/www/liteadmin/src/ext vec0.so; \
    rm /tmp/sqlite-vec.tar.gz

WORKDIR /var/www/liteadmin
COPY src/ ./src/

COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/php-liteadmin.ini /usr/local/etc/php/conf.d/liteadmin.ini

# Point config.json at the bundled extension: "ext_dir" resolves bare names such as "vec0"
# (the .so suffix is filled in), and a top-level "extensions" list applies to every database.
# The extension is loaded into every request, so it stays read-only to the web user.
RUN set -eux; \
    chmod +x /usr/local/bin/entrypoint.sh; \
    php -r '$c=json_decode(file_get_contents("src/config.json"),true); $c["auth"]["password_hash"]=""; $c["ext_dir"]="ext"; $c["extensions"]=["vec0"]; file_put_contents("src/config.json", json_encode($c, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE)."\n");'; \
    chown -R www-data:www-data /var/www/liteadmin/src; \
    chmod 640 /var/www/liteadmin/src/config.json; \
    chown -R root:www-data /var/www/liteadmin/src/ext; \
    chmod 750 /var/www/liteadmin/src/ext; \
    chmod 640 /var/www/liteadmin/src/ext/vec0.so

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
