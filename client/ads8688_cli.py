#!/usr/bin/env python3
"""Command-line client for discovery, control, and backlog retrieval."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import socket
import struct

import ads8688_protocol as protocol


FRAME = struct.Struct("<IHHIQIHH8HI")


def default_host() -> str | None:
    path = Path(__file__).resolve().parents[1] / ".meta" / "client" / "host.txt"
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def backlog(host: str, port: int, after: int, limit: int, output: Path | None) -> dict:
    request_id = secrets.randbits(32) or 1
    frames = 0
    first_record = last_record = None
    first_sequence = last_sequence = None
    destination = output.open("wb") if output else None
    try:
        with socket.create_connection((host, port), timeout=3.0) as stream:
            stream.settimeout(5.0)
            payload = struct.pack("!QI", after, limit)
            stream.sendall(protocol.message(protocol.READ_BACKLOG, request_id, payload))
            while True:
                message_type, reply_id, payload = protocol.receive(stream)
                if reply_id != request_id:
                    continue
                if message_type == protocol.ERROR:
                    raise RuntimeError(protocol.decode_json(payload)["error"])
                if message_type == protocol.ARCHIVE_DATA:
                    record_id = struct.unpack_from("!Q", payload)[0]
                    frame = payload[8:]
                    sequence = FRAME.unpack(frame)[3]
                    first_record = record_id if first_record is None else first_record
                    first_sequence = sequence if first_sequence is None else first_sequence
                    last_record, last_sequence = record_id, sequence
                    frames += 1
                    if destination:
                        destination.write(frame)
                elif message_type == protocol.READ_BACKLOG | protocol.RESPONSE:
                    result = protocol.decode_json(payload)
                    result.update({
                        "frames_received": frames,
                        "first_record_id": first_record,
                        "last_record_id": last_record,
                        "first_sequence": first_sequence,
                        "last_sequence": last_sequence,
                        "output": str(output) if output else None,
                    })
                    return result
    finally:
        if destination:
            destination.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=default_host())
    parser.add_argument("--port", type=int, default=protocol.TCP_PORT)
    commands = parser.add_subparsers(dest="command", required=True)
    discover_parser = commands.add_parser("discover")
    discover_parser.add_argument("--address", default="255.255.255.255")
    discover_parser.add_argument("--timeout", type=float, default=1.0)
    for name in ("hello", "status", "start", "stop", "archive-info"):
        commands.add_parser(name)
    rate_parser = commands.add_parser("set-rate")
    rate_parser.add_argument("rate", type=int)
    backlog_parser = commands.add_parser("backlog")
    backlog_parser.add_argument("--after", type=int, required=True)
    backlog_parser.add_argument("--limit", type=int, default=1000)
    backlog_parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command != "discover" and not args.host:
        parser.error("Set --host or .meta/client/host.txt")

    if args.command == "discover":
        result = protocol.discover(args.address, args.timeout)
    elif args.command == "backlog":
        result = backlog(args.host, args.port, args.after, args.limit, args.output)
    else:
        message_type = {
            "hello": protocol.HELLO,
            "status": protocol.STATUS,
            "start": protocol.ACQ_START,
            "stop": protocol.ACQ_STOP,
            "set-rate": protocol.SET_RATE,
            "archive-info": protocol.ARCHIVE_INFO,
        }[args.command]
        payload = struct.pack("!I", args.rate) if args.command == "set-rate" else b""
        result = protocol.request(args.host, message_type, payload, args.port)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
