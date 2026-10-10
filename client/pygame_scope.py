#!/usr/bin/env python3
"""Eight-channel real-time ADS8688 oscilloscope implemented with pygame."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path
import queue
import socket
import struct
import threading
import time
import zlib

import pygame
import ads8688_protocol as protocol


MAGIC = b"ADS8"
FRAME = struct.Struct("<IHHIQIHH8HI")
CHANNELS = 8
FULL_SCALE_VOLTS = 10.24
COLORS = (
    (66, 165, 245),
    (102, 187, 106),
    (255, 202, 40),
    (239, 83, 80),
    (171, 71, 188),
    (38, 198, 218),
    (255, 112, 67),
    (236, 64, 122),
)


def default_host() -> str:
    local = Path(__file__).resolve().parents[1] / ".meta"
    host_file = local / "client" / "host.txt"
    if host_file.exists():
        return host_file.read_text(encoding="utf-8").strip()

    connection = local / "connection.txt"
    if not connection.exists():
        raise RuntimeError("Set --host or .meta/client/host.txt")
    for line in connection.read_text(encoding="utf-8").splitlines():
        if line.lower().startswith("ip:") or line.lower().startswith("ip="):
            return line.split(line[2], 1)[1].strip()
    raise RuntimeError("IP not found in .meta/connection.txt; use --host")


def valid_frame(packet: bytes) -> bool:
    if len(packet) != FRAME.size:
        return False
    fields = FRAME.unpack(packet)
    return (
        fields[0] == 0x38534441
        and fields[1] == 1
        and fields[2] == 28
        and fields[6] == CHANNELS
        and fields[7] == 1
        and fields[-1] == zlib.crc32(packet[:-4])
    )


class Receiver(threading.Thread):
    def __init__(self, host: str, port: int, output: queue.Queue[tuple]) -> None:
        super().__init__(daemon=True)
        self.host = host
        self.port = port
        self.output = output
        self.stop_event = threading.Event()
        self.status = "connecting"
        self.bad_frames = 0
        self.last_record_id: int | None = None
        self.request_id = 1

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                with socket.create_connection((self.host, self.port), timeout=3.0) as stream:
                    stream.settimeout(5.0)
                    self._catch_up(stream)
                    request_id = self._next_request_id()
                    stream.sendall(protocol.message(protocol.STREAM_START, request_id))
                    self._wait_response(stream, protocol.STREAM_START, request_id)
                    self.status = "connected"
                    while not self.stop_event.is_set():
                        try:
                            message_type, _request_id, payload = protocol.receive(stream)
                        except (TimeoutError, socket.timeout):
                            continue
                        if message_type in (protocol.LIVE_DATA, protocol.ARCHIVE_DATA):
                            self._push_frame(payload)
            except (OSError, ValueError, RuntimeError) as error:
                self.status = f"retrying: {error}"
                self.stop_event.wait(1.0)
        self.status = "stopped"

    def _next_request_id(self) -> int:
        request_id = self.request_id
        self.request_id += 1
        return request_id

    def _push_frame(self, payload: bytes) -> None:
        if len(payload) != 8 + FRAME.size:
            self.bad_frames += 1
            return
        record_id = struct.unpack_from("!Q", payload)[0]
        packet = payload[8:]
        if not valid_frame(packet):
            self.bad_frames += 1
            return
        self.last_record_id = record_id
        item = (record_id, FRAME.unpack(packet))
        try:
            self.output.put_nowait(item)
        except queue.Full:
            try:
                self.output.get_nowait()
            except queue.Empty:
                pass
            self.output.put_nowait(item)

    def _wait_response(self, stream: socket.socket, command: int, request_id: int) -> dict:
        while True:
            message_type, reply_id, payload = protocol.receive(stream)
            if message_type in (protocol.LIVE_DATA, protocol.ARCHIVE_DATA):
                self._push_frame(payload)
            elif reply_id == request_id and message_type == protocol.ERROR:
                raise RuntimeError(protocol.decode_json(payload)["error"])
            elif reply_id == request_id and message_type == command | protocol.RESPONSE:
                return protocol.decode_json(payload)

    def _catch_up(self, stream: socket.socket) -> None:
        if self.last_record_id is None:
            return
        self.status = "catching up"
        while not self.stop_event.is_set():
            request_id = self._next_request_id()
            payload = struct.pack("!QI", self.last_record_id, 2000)
            stream.sendall(protocol.message(protocol.READ_BACKLOG, request_id, payload))
            result = self._wait_response(stream, protocol.READ_BACKLOG, request_id)
            if not result["more"] or result["returned"] == 0:
                return

    def stop(self) -> None:
        self.stop_event.set()


def raw_to_volts(raw: int) -> float:
    return ((raw / 65535.0) * 2.0 - 1.0) * FULL_SCALE_VOLTS


def draw_text(surface: pygame.Surface, font: pygame.font.Font, text: str,
              position: tuple[int, int], color=(220, 225, 230)) -> None:
    surface.blit(font.render(text, True, color), position)


def run(host: str, port: int) -> None:
    pygame.init()
    screen = pygame.display.set_mode((1280, 900), pygame.RESIZABLE)
    pygame.display.set_caption(f"ADS8688 8-channel scope - {host}:{port}")
    font = pygame.font.SysFont("consolas", 17)
    small = pygame.font.SysFont("consolas", 14)
    clock = pygame.time.Clock()
    incoming: queue.Queue[tuple] = queue.Queue(maxsize=4096)
    receiver = Receiver(host, port, incoming)
    receiver.start()

    history = [deque(maxlen=2400) for _ in range(CHANNELS)]
    raw_values = [0] * CHANNELS
    sequence: int | None = None
    sequence_gaps = 0
    received = 0
    rate = 0.0
    rate_count = 0
    rate_time = time.monotonic()
    scan_rate = 0
    record_id: int | None = None
    running = True

    try:
        while running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                    running = False

            while True:
                try:
                    record_id, frame = incoming.get_nowait()
                except queue.Empty:
                    break
                new_sequence = frame[3]
                if sequence is not None and new_sequence != (sequence + 1) & 0xFFFFFFFF:
                    sequence_gaps += (new_sequence - sequence - 1) & 0xFFFFFFFF
                sequence = new_sequence
                scan_rate = frame[5]
                samples = frame[8:16]
                for channel, raw in enumerate(samples):
                    raw_values[channel] = raw
                    history[channel].append(raw_to_volts(raw))
                received += 1
                rate_count += 1

            now = time.monotonic()
            if now - rate_time >= 1.0:
                rate = rate_count / (now - rate_time)
                rate_count = 0
                rate_time = now

            width, height = screen.get_size()
            screen.fill((14, 17, 22))
            top = 54
            bottom = 24
            panel_height = max(50, (height - top - bottom) // CHANNELS)
            plot_left = 165
            plot_right = width - 18

            draw_text(
                screen,
                font,
                f"{receiver.status}   RX {rate:7.1f} scans/s   configured {scan_rate} scans/s   "
                f"seq {sequence if sequence is not None else '-'}   gaps {sequence_gaps}   "
                f"record {record_id if record_id is not None else '-'}   CRC/resync {receiver.bad_frames}",
                (14, 14),
            )

            for channel in range(CHANNELS):
                y0 = top + channel * panel_height
                y1 = y0 + panel_height - 3
                mid = (y0 + y1) // 2
                pygame.draw.rect(screen, (24, 29, 37), (8, y0, width - 16, y1 - y0))
                pygame.draw.line(screen, (53, 60, 70), (plot_left, mid), (plot_right, mid))
                pygame.draw.line(screen, (40, 47, 56), (plot_left, y0 + 2), (plot_right, y0 + 2))
                pygame.draw.line(screen, (40, 47, 56), (plot_left, y1 - 2), (plot_right, y1 - 2))

                volts = raw_to_volts(raw_values[channel])
                draw_text(screen, font, f"CH{channel} {volts:+7.3f} V", (16, y0 + 8), COLORS[channel])
                draw_text(screen, small, f"0x{raw_values[channel]:04X}", (65, y0 + 31), (150, 157, 166))

                values = history[channel]
                if len(values) > 1 and plot_right > plot_left:
                    visible = list(values)[-(plot_right - plot_left):]
                    x_start = plot_right - len(visible) + 1
                    amplitude = max(1, (y1 - y0 - 8) // 2)
                    points = [
                        (
                            x_start + index,
                            int(mid - max(-1.0, min(1.0, value / FULL_SCALE_VOLTS)) * amplitude),
                        )
                        for index, value in enumerate(visible)
                    ]
                    pygame.draw.lines(screen, COLORS[channel], False, points, 2)

            draw_text(screen, small, "Y: +/-10.24 V fixed   X: newest samples, shared time axis   ESC: quit", (14, height - 20), (135, 143, 153))
            pygame.display.flip()
            clock.tick(60)
    finally:
        receiver.stop()
        receiver.join(timeout=2.0)
        pygame.quit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    run(args.host or default_host(), args.port)


if __name__ == "__main__":
    main()
