#!/bin/bash
# push.sh — tag the local image for GitHub Container Registry and push (rc + latest).
#
# Usage:
#   GHCR_USERNAME=<user> GHCR_TOKEN=<token> ./push.sh
#   ./push.sh <username> <token>                 # positional alternative
#   DSH_VERSION=<version> ./push.sh ...          # push a different build
#
# Versioning policy: image tags ALWAYS match the upstream npm version of
# @deepseek-ai/dsh (e.g. 0.2.2-rc.1). No patch suffixes. Bump the tag only
# when upstream publishes a new version; same-tag re-pushes keep the tag.
#
# The token needs the `write:packages` scope (a GitHub PAT) or the
# `packages: write` permission (a GitHub App token, username x-access-token).
# Create a PAT at https://github.com/settings/tokens.
set -euo pipefail

USERNAME="${1:-${GHCR_USERNAME:-}}"
TOKEN="${2:-${GHCR_TOKEN:-}}"
DSH_VERSION="${DSH_VERSION:-0.2.2-rc.1}"
REGISTRY="ghcr.io"
LOCAL_IMAGE="deepseek-harness:${DSH_VERSION}"
REMOTE_IMAGE="${REGISTRY}/${USERNAME}/deepseek-harness"

if [ -z "$USERNAME" ] || [ -z "$TOKEN" ]; then
  echo "usage: GHCR_USERNAME=... GHCR_TOKEN=... ./push.sh  (or: ./push.sh <user> <token>)" >&2
  exit 1
fi

if ! docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1; then
  echo "error: local image $LOCAL_IMAGE not found — run: docker build -t $LOCAL_IMAGE ." >&2
  exit 1
fi

echo "==> tagging $REMOTE_IMAGE:${DSH_VERSION} and :latest"
docker tag "$LOCAL_IMAGE" "$REMOTE_IMAGE:${DSH_VERSION}"
docker tag "$LOCAL_IMAGE" "$REMOTE_IMAGE:latest"

echo "==> logging in to ghcr.io (token)"
echo "$TOKEN" | docker login "$REGISTRY" --username "$USERNAME" --password-stdin

echo "==> pushing"
docker push "$REMOTE_IMAGE:${DSH_VERSION}"
docker push "$REMOTE_IMAGE:latest"

echo "==> done:"
echo "   ${REMOTE_IMAGE}:${DSH_VERSION}"
echo "   ${REMOTE_IMAGE}:latest"
echo "用此地址在雨云 RCA 模板「镜像」字段填写: ${REMOTE_IMAGE}:${DSH_VERSION}"
