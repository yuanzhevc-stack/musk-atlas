#!/bin/sh
# The old bulk loop is paused. Do not start tmux session musk-cache.
# Leave pipeline.stop and USER_PAUSED where they are.
# A later manual-only start, after the Worker deploy, is one job:
#   python3 cache_full.py --manual
# or a loop that still claims only pasted-link jobs:
#   python3 cache_full.py --manual --loop
echo "Refusing to start the bulk cache loop. Use cache_full.py --manual for a pasted YouTube link." >&2
exit 0
