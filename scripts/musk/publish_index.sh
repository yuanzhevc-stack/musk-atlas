#!/bin/bash
# Rebuild the sharded index from /workspace/musk-corpus/full.db and publish it to GitHub Pages.
# Only public/musk/index/ is committed (text); clips are on R2. Usage: scripts/musk/publish_index.sh [--no-push]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; CORPUS=/workspace/musk-corpus
cd "$CORPUS" && .venv/bin/python shard_index.py
rm -rf "$REPO/public/musk/index.new" && cp -r "$CORPUS/index" "$REPO/public/musk/index.new"
rm -rf "$REPO/public/musk/index" && mv "$REPO/public/musk/index.new" "$REPO/public/musk/index"
cd "$REPO"
SIZE=$(du -sm public/musk/index | cut -f1); [ "$SIZE" -lt 400 ] || { echo "index too large: ${SIZE}MB"; exit 1; }
[ "${1:-}" = "--no-push" ] && exit 0
git add -A public/musk/index
if git diff --cached --quiet; then echo "index unchanged"; exit 0; fi
N=$(python3 -c "import json;m=json.load(open('public/musk/index/manifest.json'));print(len(m['videos']),m['n'],m['labels'].get('musk',0))")
git -c user.name="yuanzhevc-stack" -c user.email="yuanzhevc-stack@users.noreply.github.com" commit -qm "Update Musk index: $N (videos sentences musk)" -- public/musk/index
git push -q origin main && echo "pushed: $N"
