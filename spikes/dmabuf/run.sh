#!/usr/bin/env bash
# Spike (throwaway): the measurement battery. Each run maps a layer surface on $OUTPUT for warmup+seconds, then
# removes it. Results append to out/results.jsonl, per-run logs land in out/<label>.{txt,err}.
# Stop the legacy wallpaper first (curl -s -X POST 127.0.0.1:5174/stop) so it doesn't compete for the GPU.
#   bash spikes/dmabuf/run.sh               # whole battery (24 runs, ~24 min)
#   bash spikes/dmabuf/run.sh fence-signaled-vblank load-finish-vblank   # selected runs by label
set -u
cd "$(dirname "$0")"
OUTPUT=${OUTPUT:-DP-2}
SECS=${SECONDS_PER_RUN:-60}
WORK=2500 # LIASCAPE_SPIKE_WORK for the "load" runs: ~3.7 ms of GPU per frame on an RTX 3070 Ti
mkdir -p out

# label | env | consumer args (window length appended unless the args set --seconds)
battery=(
    "fence-gpuwait-vblank||--mode fence --latch gpu-wait --redraw vblank"
    "fence-gpuwait-new||--mode fence --latch gpu-wait --redraw new"
    "fence-signaled-vblank||--mode fence --latch signaled --redraw vblank"
    "fence-signaled-new||--mode fence --latch signaled --redraw new"
    "finish-vblank||--mode finish --redraw vblank"
    "finish-new||--mode finish --redraw new"
    "shm-vblank||--mode shm --redraw vblank"
    "shm-new||--mode shm --redraw new"
    "nosync-vblank||--mode nosync --redraw vblank"
    "local-vblank||--mode local --redraw vblank"
    "fence-signaled-vblank-noverify||--mode fence --latch signaled --redraw vblank --verify off"
    "load-fence-gpuwait-vblank|LIASCAPE_SPIKE_WORK=$WORK|--mode fence --latch gpu-wait --redraw vblank"
    "load-fence-signaled-vblank|LIASCAPE_SPIKE_WORK=$WORK|--mode fence --latch signaled --redraw vblank"
    "load-fence-signaled-new|LIASCAPE_SPIKE_WORK=$WORK|--mode fence --latch signaled --redraw new"
    "load-finish-vblank|LIASCAPE_SPIKE_WORK=$WORK|--mode finish --redraw vblank"
    "load-finish-vblank-glyield-usleep|LIASCAPE_SPIKE_WORK=$WORK __GL_YIELD=USLEEP|--mode finish --redraw vblank --seconds 30"
    "load-fence-signaled-vblank-prio|LIASCAPE_SPIKE_WORK=$WORK LIASCAPE_SPIKE_CONSUMER_PRIO=high LIASCAPE_SPIKE_PRODUCER_PRIO=low|--mode fence --latch signaled --redraw vblank"
    "fdpoll-vblank||--mode fdpoll --redraw vblank"
    "load-fdpoll-vblank|LIASCAPE_SPIKE_WORK=$WORK|--mode fdpoll --redraw vblank"
    "sat-fence-gpuwait-vblank|LIASCAPE_SPIKE_WORK=4000|--mode fence --latch gpu-wait --redraw vblank --seconds 20"
    "sat-fence-signaled-vblank|LIASCAPE_SPIKE_WORK=4000|--mode fence --latch signaled --redraw vblank --seconds 20"
    "crash-idle-signaled||--mode fence --latch signaled --redraw vblank --seconds 15 --kill-at 5.1"
    "crash-load-gpuwait|LIASCAPE_SPIKE_WORK=$WORK|--mode fence --latch gpu-wait --redraw vblank --seconds 15 --kill-at 5.1"
    "crash-load-signaled|LIASCAPE_SPIKE_WORK=$WORK|--mode fence --latch signaled --redraw vblank --seconds 15 --kill-at 5.2"
)

want=("$@")
for entry in "${battery[@]}"; do
    IFS='|' read -r label envs args <<<"$entry"
    if [ ${#want[@]} -gt 0 ] && [[ " ${want[*]} " != *" $label "* ]]; then
        continue
    fi
    [[ "$args" == *--seconds* ]] || args="$args --seconds $SECS"
    echo "=== $label  [$envs] $args"
    # shellcheck disable=SC2086
    env -u LD_LIBRARY_PATH $envs ./consumer $args --output "$OUTPUT" --label "$label" --out out/results.jsonl \
        >"out/$label.txt" 2>"out/$label.err"
    echo "    exit $?"
    grep -E "DELIVERED|RESULT|consumer cpu|producer:|checks|present |CRASH" "out/$label.txt" | sed 's/^/    /'
    sleep 2
done
