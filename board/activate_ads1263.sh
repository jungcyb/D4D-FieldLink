#!/bin/sh
set -eu

R5_NAME=78400000.r5f
R5_CUSTOM=ads1263/am64-main-r5f1_0-fw
R5_DEFAULT=am64-main-r5f1_0-fw
POWER_CHIP=gpiochip0
POWER_LINE=5
POWER_CONSUMER=ads1263-rpi3v3
POWER_SOURCE=${2:-external}
case "$POWER_SOURCE" in
    external|header) ;;
    *) echo 'power source must be external or header' >&2; exit 2 ;;
esac

find_remoteproc() {
    for path in /sys/class/remoteproc/remoteproc*; do
        [ "$(cat "$path/name")" = "$R5_NAME" ] && {
            printf '%s\n' "$path"
            return 0
        }
    done
    return 1
}

stop_core() {
    [ "$(cat "$1/state")" != running ] || echo stop > "$1/state"
}

start_core() {
    echo "$2" > "$1/firmware"
    echo start > "$1/state"
}

power_pid() {
    for process in /proc/[0-9]*; do
        [ "$(cat "$process/comm" 2>/dev/null || true)" = gpioset ] || continue
        command=$(tr '\000' ' ' < "$process/cmdline")
        case "$command" in
            *"$POWER_CONSUMER"*) basename "$process"; return 0 ;;
        esac
    done
    return 1
}

set_header_3v3() {
    pid=$(power_pid || true)
    [ -z "$pid" ] || kill "$pid"
    gpioset -z -c "$POWER_CHIP" -C "$POWER_CONSUMER" "$POWER_LINE=$1"
    sleep 1
    state=lo
    [ "$1" != 1 ] || state=hi
    grep -q "RPI_PS_3V3_En.*$POWER_CONSUMER.*out $state" /sys/kernel/debug/gpio
}

R5=$(find_remoteproc)

case "${1:-}" in
    start)
        stop_core "$R5"
        if [ "$POWER_SOURCE" = header ]; then
            set_header_3v3 0
            set_header_3v3 1
        fi
        start_core "$R5" "$R5_CUSTOM"
        ;;
    stop)
        stop_core "$R5"
        start_core "$R5" "$R5_DEFAULT"
        [ "$POWER_SOURCE" != header ] || set_header_3v3 0
        ;;
    status)
        printf 'R5FSS1-0 %s %s %s\n' "$R5" \
            "$(cat "$R5/state")" "$(cat "$R5/firmware")"
        grep 'RPI_PS_3V3_En' /sys/kernel/debug/gpio || true
        ;;
    *)
        echo "usage: $0 {start|stop|status} [external|header]" >&2
        exit 2
        ;;
esac
