# deploy/clamav/Dockerfile — ChartWarden's ClamAV (clamd + freshclam) for the M36 attachment scanner, on Wolfi.
#
# Replaces upstream's clamav/clamav (Alpine; clamav-debian before it) so the scanner shares the Postgres image's
# base, scan and signing chain. One multi-arch image for dev (Apple Silicon included) and production: dev compose
# builds this folder; production moves to the digest .github/workflows/clamav-image.yml publishes once compose.yml pins it
# (until then it still runs upstream's Alpine image).
#
# Same contract as upstream's /init: the signature DB lives in the /var/lib/clamav volume (chowned to this image's
# clamav uid on every start, so a volume an older image created still opens), freshclam fetches it on the first start
# and then refreshes it in-container (a retrying loop, entrypoint.sh), and clamd runs in the foreground reading /etc/clamav/clamd.conf, which the
# compose files bind-mount (deploy/clamav/clamd.conf). clamd drops to `clamav` (the mounted config sets no User).
# Port 3310 is unauthenticated: compose-network only, on the `scan` network (see clamd.conf).
#
# Bump: refresh the base digest (`crane digest cgr.dev/chainguard/wolfi-base:latest`) and the package pins
# (`apk add -s <pkgs>` in that base shows what resolves); Wolfi keeps old versions, so pins stay buildable.
# Wolfi's clamav-1.4 stops at 1.4.3 (production's Alpine image had 1.4.6), so this runs the 1.5 line. Moving engine line
# is an upgrade, not a base bump.
FROM cgr.dev/chainguard/wolfi-base@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1

ARG CLAMAV_VERSION=1.5.2-r7

# uid/gid 100 is the clamav user upstream's Alpine image used, so the existing production volume needs no re-chown.
RUN addgroup -g 100 clamav \
 && adduser -D -H -u 100 -G clamav -h /var/lib/clamav -s /sbin/nologin clamav \
 && apk add --no-cache \
      "clamav-1.5=${CLAMAV_VERSION}" \
      "clamav-1.5-daemon=${CLAMAV_VERSION}" \
      "clamav-1.5-freshclam=${CLAMAV_VERSION}" \
      "clamav-1.5-clamdscan=${CLAMAV_VERSION}" \
      gosu=1.20-r1 tini=0.19.0-r27 netcat-openbsd=1.239-r1 \
 && install -d -o clamav -g clamav -m 0755 /var/lib/clamav /var/log/clamav

COPY freshclam.conf /etc/clamav/freshclam.conf
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

VOLUME /var/lib/clamav
EXPOSE 3310
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
