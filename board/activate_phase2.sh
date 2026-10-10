#!/bin/sh
set -eu

M4_NAME=5000000.m4fss
R5_NAME=78000000.r5f
M4_CUSTOM=ads8688/m4_ads8688_stream.out
R5_CUSTOM=ads8688/r5_ads8688_relay.out
M4_DEFAULT=am64-mcu-m4f0_0-fw
R5_DEFAULT=am64-main-r5f0_0-fw
# ADS1263 4-channel scan on R5FSS1-0. On stop it is left offline: TI's default
# R5FSS1-0 echo image has been seen to ignore the next remoteproc shutdown.
ADC2_NAME=78400000.r5f
ADC2_CUSTOM=ads1263_scan/am64-main-r5f1_0-fw

find_remoteproc() {
    wanted=$1
    for path in /sys/class/remoteproc/remoteproc*; do
        [ "$(cat "$path/name")" = "$wanted" ] && {
            printf '%s\n' "$path"
            return 0
        }
    done
    return 1
}

stop_core() {
    path=$1
    [ "$(cat "$path/state")" != running ] || echo stop > "$path/state"
}

start_core() {
    path=$1
    firmware=$2
    echo "$firmware" > "$path/firmware"
    echo start > "$path/state"
}

M4=$(find_remoteproc "$M4_NAME")
R5=$(find_remoteproc "$R5_NAME")
ADC2=$(find_remoteproc "$ADC2_NAME" || true)

case "${1:-}" in
    start)
        stop_core "$M4"
        sleep 1
        stop_core "$R5"
        sleep 1
        start_core "$R5" "$R5_CUSTOM"
        sleep 1
        start_core "$M4" "$M4_CUSTOM"
        sleep 1
        if [ -n "$ADC2" ] && [ -f "/lib/firmware/$ADC2_CUSTOM" ]; then
            stop_core "$ADC2"
            start_core "$ADC2" "$ADC2_CUSTOM"
            sleep 1
        fi
        ;;
    stop)
        stop_core "$M4"
        sleep 1
        stop_core "$R5"
        sleep 1
        start_core "$R5" "$R5_DEFAULT"
        sleep 1
        start_core "$M4" "$M4_DEFAULT"
        [ -z "$ADC2" ] || stop_core "$ADC2"
        ;;
    status)
        printf 'M4 %s %s %s\n' "$M4" "$(cat "$M4/state")" "$(cat "$M4/firmware")"
        printf 'R5 %s %s %s\n' "$R5" "$(cat "$R5/state")" "$(cat "$R5/firmware")"
        [ -z "$ADC2" ] || printf 'ADS1263 %s %s %s\n' "$ADC2" "$(cat "$ADC2/state")" "$(cat "$ADC2/firmware")"
        ;;
    *)
        echo "usage: $0 {start|stop|status}" >&2
        exit 2
        ;;
esac
