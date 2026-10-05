#!/usr/bin/env bash
# Fetches the Effect guides and sources that match the pinned `effect` version
# into .repos/effect (gitignored). Agents read them before writing Effect code.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/^  effect: //p' "$root/pnpm-workspace.yaml")"
target="$root/.repos/effect"

if [[ -z "$version" ]]; then
  echo "effect version not found in pnpm-workspace.yaml catalog" >&2
  exit 1
fi

rm -rf "$target"
git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse \
  --branch "effect@$version" https://github.com/Effect-TS/effect.git "$target"
git -C "$target" sparse-checkout set --no-cone \
  /LLMS.md /MIGRATION.md /ai-docs/ /packages/effect/src/ \
  /packages/sql/sqlite-node/src/ /packages/platform/node/src/ /packages/vitest/src/
rm -rf "$target/.git"
echo "Effect $version reference synced to .repos/effect"
