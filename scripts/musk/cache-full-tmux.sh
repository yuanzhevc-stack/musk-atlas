#!/bin/sh
# This host has no systemd user bus. Run the downloader in tmux instead.
# The secret stays in cache-full.env, which is not part of the git repo.
cd /workspace/musk-atlas-cache-runtime || exit 1
if [ ! -f cache-full.env ]; then
  echo "cache-full.env is missing" >&2
  exit 1
fi
set -a
. ./cache-full.env
set +a
if [ -z "$CACHE_JOB_SECRET" ]; then
  echo "CACHE_JOB_SECRET is empty; claims stay closed" >&2
  exit 1
fi
mkdir -p log
if tmux has-session -t musk-cache 2>/dev/null; then
  echo "tmux session musk-cache already exists"
  exit 0
fi
tmux new-session -d -s musk-cache "exec ./venv/bin/python ./cache_full.py --loop >> log/cache-full.log 2>&1"
echo "started tmux session musk-cache"
