#!/usr/bin/env bash
# Publish wiki/*.md to the GitHub wiki of CodeMusic/gpt-play-pokemon-firered-daemons.
# The pages are kept in wiki/ so they are versioned with the code. Commit them first, then run this.
# A page deleted here is not deleted from the wiki: remove it there by hand.
# GitHub creates the wiki's git repository only once its first page is saved in the browser.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
sha="$(git -C "$repo_root" rev-parse --short HEAD)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ! git clone --quiet https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons.wiki.git "$tmp/wiki" 2>/dev/null; then
  echo "Could not clone the wiki. It needs its first page saved in the browser:" >&2
  echo "  https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/wiki -> Wiki tab > Create the first page, then save." >&2
  exit 1
fi

cp "$here"/*.md "$tmp/wiki/"

cd "$tmp/wiki"
git add -A
if git diff --cached --quiet; then
  echo "The wiki already matches wiki/ at $sha. Nothing to publish."
  exit 0
fi
git commit --quiet -m "Wiki: from wiki/ at $sha"
git push --quiet
echo "Published the wiki from wiki/ at $sha."
