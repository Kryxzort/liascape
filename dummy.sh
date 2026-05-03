#!/bin/bash
mpvpaper -o "--input-ipc-server=/tmp/test2.sock --loop-file=inf" * "/home/kryxzort/Projects/Claude playground/livepaper/src/livepaper/Assets/1.mp4" &
sleep 2
echo '{"command":["get_property","playtime-remaining"]}' | socat - /tmp/test2.sock
pkill -f mpvpaper
