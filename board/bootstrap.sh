#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"

usage() {
    echo "Usage: $0 [--check|--install]"
}

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

network_config_hashes() {
    local path
    for path in /etc/NetworkManager/system-connections /etc/systemd/network /etc/network; do
        if [[ -d "$path" ]]; then
            while IFS= read -r -d '' file; do
                sha256sum "$file"
            done < <(find "$path" -type f -print0 | sort -z)
        elif [[ -f "$path" ]]; then
            sha256sum "$path"
        fi
    done
}

check_board() {
    local model os_id os_like arch python_version rpmsg_count state name

    model="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"
    arch="$(uname -m)"
    # shellcheck disable=SC1091
    source /etc/os-release
    os_id="${ID:-unknown}"
    os_like="${ID_LIKE:-}"

    [[ "$arch" == "aarch64" ]] || fail "Expected aarch64, got $arch"
    case "$model" in
        *AM64*|*AM642*) ;;
        *) fail "Expected AM64x SK, got: ${model:-unknown}" ;;
    esac
    if [[ "$os_id" != "debian" && "$os_like" != *debian* ]]; then
        fail "Expected Debian-family OS, got ID=$os_id ID_LIKE=$os_like"
    fi

    echo "model=$model"
    echo "os=${PRETTY_NAME:-$os_id}"
    echo "kernel=$(uname -r)"
    echo "arch=$arch"
    echo "uptime_seconds=$(cut -d. -f1 /proc/uptime)"

    if command -v python3 >/dev/null 2>&1; then
        python_version="$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
        echo "python=$python_version"
    else
        echo "python=missing"
    fi

    echo "--- network (read-only) ---"
    ip -brief link
    ip -brief address
    ip route
    for name in NetworkManager systemd-networkd systemd-timesyncd chrony; do
        state="$(systemctl is-active "$name" 2>/dev/null || true)"
        echo "$name=${state:-not-found}"
    done
    timedatectl show -p NTP -p NTPSynchronized 2>/dev/null || true

    echo "--- remoteproc/rpmsg (read-only) ---"
    shopt -s nullglob
    local rprocs=(/sys/class/remoteproc/remoteproc*)
    echo "remoteproc_count=${#rprocs[@]}"
    for path in "${rprocs[@]}"; do
        name="$(cat "$path/name" 2>/dev/null || basename "$path")"
        state="$(cat "$path/state" 2>/dev/null || echo unknown)"
        echo "$(basename "$path")=$name:$state"
    done
    rpmsg_count="$(find /dev -maxdepth 1 -name 'rpmsg*' | wc -l)"
    echo "rpmsg_device_count=$rpmsg_count"
}

install_tools() {
    local backup_dir before_hash after_hash file

    [[ "$EUID" -eq 0 ]] || fail "--install must run as root"
    ip route show default | grep -q . || fail "No default route; fix LAN before installing"
    getent hosts deb.debian.org >/dev/null || fail "DNS is not working; fix LAN before installing"

    backup_dir=/var/backups/ads8688-initial
    before_hash="$backup_dir/network-config.before.sha256"
    after_hash="$backup_dir/network-config.after.sha256"
    mkdir -p "$backup_dir/files"

    network_config_hashes >"$before_hash"

    for file in /boot/armbianEnv.txt /boot/uEnv.txt; do
        if [[ -e "$file" ]]; then
            cp -a --parents "$file" "$backup_dir/files"
        fi
    done
    while IFS= read -r -d '' file; do
        cp -a --parents "$file" "$backup_dir/files"
    done < <(find /boot -type f -name 'k3-am642-sk*.dtb' -print0 2>/dev/null)
    if [[ -e /lib/firmware/ti-ipc ]]; then
        cp -aL --parents /lib/firmware/ti-ipc "$backup_dir/files"
    fi

    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv build-essential git device-tree-compiler

    python3 - <<'PY'
import sys
if sys.version_info[:2] != (3, 13):
    raise SystemExit(f"Python 3.13 required, found {sys.version.split()[0]}")
PY

    python3 -m venv /opt/ads8688/venv
    python3 -m pip --version
    /opt/ads8688/venv/bin/python --version

    if [[ -d /sys/firmware/devicetree/base ]]; then
        dtc -I fs -O dts /sys/firmware/devicetree/base \
            -o "$backup_dir/am64-live.dts" 2>"$backup_dir/dtc-warnings.txt" || true
    fi

    network_config_hashes >"$after_hash"
    if ! cmp -s "$before_hash" "$after_hash"; then
        diff -u "$before_hash" "$after_hash" || true
        fail "Network configuration changed unexpectedly"
    fi

    echo "Install complete. Network config was not changed."
    echo "Baseline backup: $backup_dir"
    echo "No reboot was performed."
}

case "$mode" in
    --check)
        check_board
        ;;
    --install)
        check_board
        install_tools
        check_board
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
