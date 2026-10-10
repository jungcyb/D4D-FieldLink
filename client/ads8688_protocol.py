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
LIVE_DATA = 0x0100
ARCHIVE_DATA = 0x0101
ARCHIVE_DATA_V2 = 0x0102
LIVE_DATA_V2 = 0x0103
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


def discover(
    address: str = "255.255.255.255",
    timeout: float = 1.0,
    port: int = DISCOVERY_PORT,
) -> list[dict]:
    nonce = secrets.randbits(64)
    query = DISCOVERY_REQUEST.pack(b"A8DQ", VERSION, 0, nonce)
    found: dict[uuid.UUID, dict] = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as stream:
        stream.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        stream.bind(("0.0.0.0", 0))
        stream.settimeout(max(timeout, 0.05))
        stream.sendto(query, (address, port))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            stream.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                packet, source = stream.recvfrom(1024)
            except TimeoutError:
                break
            if len(packet) < DISCOVERY_RESPONSE.size:
                continue
            fields = DISCOVERY_RESPONSE.unpack_from(packet)
            magic, version, status, received_nonce, raw_uuid, tcp_port, host_len, model_len = fields
            if magic != b"A8DR" or version != VERSION or status or received_nonce != nonce:
                continue
            offset = DISCOVERY_RESPONSE.size
            if len(packet) != offset + host_len + model_len:
                continue
            identity = uuid.UUID(bytes=raw_uuid)
            found[identity] = {
                "uuid": str(identity),
                "ip": source[0],
                "tcp_port": tcp_port,
                "hostname": packet[offset:offset + host_len].decode("utf-8", "replace"),
                "model": packet[offset + host_len:].decode("utf-8", "replace"),
            }
    return list(found.values())
