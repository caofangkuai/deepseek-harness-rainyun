# syntax=docker/dockerfile:1
# DeepSeek Harness (`dsh`) — Web UI Docker image.
#
# Built from the published npm CLI (@deepseek-ai/dsh), which bundles the built
# frontend (dist) and every profile package, so no source checkout is needed.
#
# Build:  docker build -t deepseek-harness:0.2.2-rc.1 .
# Run:    docker run -d -p 3080:3080 -v dsh-data:/data deepseek-harness:0.2.2-rc.1
#
# Runtime user: root by default. The entrypoint keeps root for dsh and the
# auth gate; set DSH_RUNTIME_UID to a non-zero uid to drop privileges instead.

# ── stage 1: install the dsh CLI + compile its native addons ────────────────
FROM node:24-trixie-slim AS dsh-install
ARG DSH_VERSION=0.2.2-rc.1
# node-pty / koffi build native code at install time, so the build stage needs
# a toolchain; the runtime stage ships only the compiled artifacts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION} --no-audit --no-fund \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs

# ── stage 2: runtime ────────────────────────────────────────────────────────
FROM node:24-trixie-slim
ENV NODE_ENV=production \
    DSH_HOME=/data \
    DSH_TELEMETRY_DISABLED=1 \
    PORT=3080
# pnpm is needed at runtime by `dsh plugin` for out-of-tree bundle installs.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable \
 && corepack prepare pnpm@11.7.0 --activate
# Tools the agent needs: ripgrep (fs-search tool shells out to it), bubblewrap
# (Linux sandbox candidate; Landlock is the other, kernel 5.13+), plus common
# utilities for agent work.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ripgrep bubblewrap ca-certificates curl git procps \
 && rm -rf /var/lib/apt/lists/*

# Native addons were compiled in dsh-install; ship only the built artifacts.
COPY --from=dsh-install /usr/local/bin /usr/local/bin
COPY --from=dsh-install /usr/local/lib/node_modules /usr/local/lib/node_modules

# Optional build-time patch to disable the /api browser-trust fence
# (DSH_TRUST_FENCE=0). The gate already rewrites Host and strips Origin, so the
# default fence works without any trusted-host configuration. dsh 0.2.2-rc.1 no
# longer calls the unguarded crypto.randomUUID() that older releases needed a
# browser polyfill for, so the polyfill step is dropped.
COPY patch-trust-fence.mjs /usr/local/bin/
RUN node /usr/local/bin/patch-trust-fence.mjs

# Remote account login: dsh only accepts a loopback OAuth callback origin by
# default. The patch removes that check and accepts any HTTP(S) origin. The
# DeepSeek Platform must also accept the resulting redirect_uri; loopback /
# SSH forwarding remains the documented fallback.
COPY patch-remote-oauth.mjs /usr/local/bin/
RUN node /usr/local/bin/patch-remote-oauth.mjs

# Built-in password gate (default on via DSH_AUTH=1, see docker-entrypoint.sh):
# first visit registers a password, afterwards login is required. dsh itself
# binds only 127.0.0.1; the gate owns the public port.
COPY auth-proxy.js /usr/local/bin/
RUN chmod 755 /usr/local/bin/auth-proxy.js

# The agent's working directory; mount a volume here to give it a workspace.
WORKDIR /workspace

# The official node image ships a `node` user (uid 1000). This image runs as
# root by default: the entrypoint self-heals persistent-volume ownership (K8s /
# RainYun volumes are root-owned and do not inherit image ownership) and keeps
# root for every long-lived process. Set DSH_RUNTIME_UID (e.g. 1000) to drop
# privileges to an unprivileged uid instead. The directories are pre-chowned
# so a non-root override can write immediately.
RUN mkdir -p /data /workspace \
 && chown -R node:node /data /workspace

# All user data (settings, credentials, sessions, profiles) lives under
# $DSH_HOME — mount a volume at /data to persist across restarts.
VOLUME /data
EXPOSE 3080

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3080),{redirect:'manual'}).then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))"

COPY docker-entrypoint.sh /usr/local/bin/dsh-entrypoint
RUN chmod 755 /usr/local/bin/dsh-entrypoint

# Default runtime user is root; set DSH_RUNTIME_UID to a non-zero uid to drop.
USER root
ENTRYPOINT ["dsh-entrypoint"]
