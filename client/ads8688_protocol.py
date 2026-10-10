"""PC-side ADS8688 discovery and TCP protocol helpers."""

from __future__ import annotations

import json
import secrets
import socket
import struct
import time
import uuid


VERSION = 1
TCP_PORT = 8765
DISCOVERY_PORT = 8764
NET_HEADER = struct.Struct("!IHHI")
DISCOVERY_REQUEST = struct.Struct("!4sHHQ")
DISCOVERY_RESPONSE = struct.Struct("!4sHHQ16sHBB")

HELLO = 1
STATUS = 2
ACQ_START = 3
ACQ_STOP = 4
SET_RATE = 5
STREAM_START = 6
STREAM_STOP = 7
ARCHIVE_INFO = 8
READ_BACKLOG = 9
READ_BACKLOG_V2 = 10
STREAM_START_V2 = 11
SET_RATE_GROUP = 12
STREAM_START_V3 = 13
READ_BACKLOG_V3 = 14
LIVE_DATA = 0x0100
ARCHIVE_DATA = 0x0101
ARCHIVE_DATA_V2 = 0x0102
LIVE_DATA_V2 = 0x0103
ANOMALY_EVENT = 0x0104
RESPONSE = 0x8000
ERROR = 0xFFFF


def message(message_type: int, request_id: int, payload: bytes = b"") -> bytes:
    return NET_HEADER.pack(len(payload), VERSION, message_type, request_id) + payload


def receive(stream: socket.socket) -> tuple[int, int, bytes]:
    header = receive_exact(stream, NET_HEADER.size)
    payload_size, version, message_type, request_id = NET_HEADER.unpack(header)
    if version != VERSION or payload_size > 64 * 1024:
        raise ValueError("invalid protocol header")
    return message_type, request_id, receive_exact(stream, payload_size)


def receive_exact(stream: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = stream.recv(size - len(data))
        if not chunk:
            raise ConnectionError("server closed connection")
        data.extend(chunk)
    return bytes(data)


def decode_json(payload: bytes) -> dict:
    return json.loads(payload.decode("utf-8"))


def request(host: str, message_type: int, payload: bytes = b"", port: int = TCP_PORT) -> dict:
    request_id = secrets.randbits(32) or 1
    with socket.create_connection((host, port), timeout=3.0) as stream:
        stream.sendall(message(message_type, request_id, payload))
        while True:
            reply_type, reply_id, reply = receive(stream)
            if reply_id != request_id:
                continue
            if reply_type == ERROR:
                raise RuntimeError(decode_json(reply)["error"])
            if reply_type == message_type | RESPONSE:
                return decode_json(reply)


def normalize_capabilities(value: object) -> dict:
    """Expand discovery v2 arrays without guessing writable channel groups."""
    if not isinstance(value, dict):
        raise ValueError("invalid channel capabilities")
    channels, groups = value.get("channels"), value.get("sampleRateGroups")
    if not isinstance(channels, list) or not 0 <= len(channels) <= 64 or not isinstance(groups, list) or len(groups) > 64:
        raise ValueError("invalid channel inventory")
    channel_keys = ("id", "label", "adc", "adcChannel", "sampleRateHz", "inputUnit", "rateGroupId", "streamAvailable")
    group_keys = ("id", "label", "channelIds", "currentHz", "writable", "minHz", "maxHz", "stepHz")
    channels = [dict(zip(channel_keys, c)) if isinstance(c, list) and len(c) == 8 else c for c in channels]
    groups = [dict(zip(group_keys, g)) if isinstance(g, list) and len(g) == 8 else g for g in groups]
    if value.get("channelCount") != len(channels):
        raise ValueError("channel count mismatch")
    for channel in channels:
        if not isinstance(channel, dict) or not isinstance(channel.get("id"), str) or not 1 <= len(channel["id"]) <= 100:
            raise ValueError("invalid channel identifier")
    if len({c["id"] for c in channels}) != len(channels):
        raise ValueError("duplicate channels")
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("id"), str) or not isinstance(group.get("channelIds"), list):
            raise ValueError("invalid rate group")
        if any(c not in {row["id"] for row in channels} for c in group["channelIds"]):
            raise ValueError("unknown rate group channel")
    return {**value, "channels": channels, "sampleRateGroups": groups}


def decode_discovery(packet: bytes, source_ip: str, nonce: int) -> dict | None:
    if len(packet) < DISCOVERY_RESPONSE.size:
        return None
    magic, version, status, received_nonce, raw_uuid, tcp_port, host_len, model_len = DISCOVERY_RESPONSE.unpack_from(packet)
    if magic != b"A8DR" or version not in (1, 2) or status or received_nonce != nonce or not tcp_port:
        return None
    offset = DISCOVERY_RESPONSE.size
    capability_size = 0
    if version == 2:
        if len(packet) < offset + 2:
            return None
        capability_size = struct.unpack_from("!H", packet, offset)[0]
        offset += 2
    if len(packet) != offset + host_len + model_len + capability_size:
        return None
    result = {"uuid": str(uuid.UUID(bytes=raw_uuid)), "ip": source_ip, "tcp_port": tcp_port,
              "hostname": packet[offset:offset + host_len].decode("utf-8", "replace"),
              "model": packet[offset + host_len:offset + host_len + model_len].decode("utf-8", "replace")}
    if capability_size:
        try:
            result["channel_capabilities"] = normalize_capabilities(json.loads(packet[-capability_size:]))
        except (ValueError, TypeError):
            return None
    return result


def discover(
    address: str = "255.255.255.255",
    timeout: float = 1.0,
    port: int = DISCOVERY_PORT,
) -> list[dict]:
    nonce = secrets.randbits(64)
    found: dict[str, dict] = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as stream:
        stream.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        stream.bind(("0.0.0.0", 0))
        stream.settimeout(max(timeout, 0.05))
        # Legacy firmware may only answer v1; prefer the richer v2 response.
        for version in (2, 1):
            stream.sendto(DISCOVERY_REQUEST.pack(b"A8DQ", version, 0, nonce), (address, port))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            stream.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                packet, source = stream.recvfrom(65535)
            except TimeoutError:
                break
            board = decode_discovery(packet, source[0], nonce)
            if board and ("channel_capabilities" in board or "channel_capabilities" not in found.get(board["uuid"], {})):
                found[board["uuid"]] = board
    return list(found.values())
