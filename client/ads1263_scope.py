#!/usr/bin/env python3
"""Two-channel, unverified ADS1263 raw diagnostic scope via SSH."""
from __future__ import annotations

import argparse
from collections import deque
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
import pygame

ROOT = Path(__file__).resolve().parents[1]
RED = (255, 112, 114)
GREEN = (72, 214, 164)
TEXT = (222, 230, 239)
MUTED = (151, 170, 190)


class Receiver(threading.Thread):
    def __init__(self, host: str, user: str, output: queue.Queue):
        super().__init__(daemon=True)
        self.host, self.user, self.output = host, user, output
        self.stop_event = threading.Event()
        self.process = None
        self.status = "Connecting over SSH..."
        self.dropped = 0

    def run(self):
        env = os.environ.copy()
        env.update(SSH_ASKPASS=str(ROOT / "tools/ssh/askpass.cmd"),
                   SSH_ASKPASS_REQUIRE="force", DISPLAY="codex-ssh")
        command = ["ssh", "-T", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=3",
                   "-o", "ServerAliveCountMax=2", "-o",
                   f"UserKnownHostsFile={ROOT / '.meta/tools/ssh/known_hosts'}",
                   f"{self.user}@{self.host}", "python3 -u /opt/ads1263/ads1263_diag.py"]
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding="utf-8", errors="replace", env=env, bufsize=1,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for line in self.process.stdout:
                if self.stop_event.is_set():
                    break
                try:
                    item = json.loads(line)
                except ValueError:
                    self.status = line.strip()[:140]
                    continue
                if item.get("event") == "started":
                    self.status = ("LIVE RAW / " + ("ADC registers verified" if item.get("configured")
                                   else "ADC INITIALIZATION FAILED / channel config unverified"))
                if "channel" not in item:
                    continue
                try:
                    self.output.put_nowait(item)
                except queue.Full:
                    self.dropped += 1
            if not self.stop_event.is_set():
                self.status = "DISCONNECTED - " + self.status
        except OSError as error:
            self.status = str(error)
        finally:
            self.stop()

    def stop(self):
        self.stop_event.set()
        process = self.process
        if process and process.poll() is None:
            try:
                process.stdin.write("stop\n")
                process.stdin.flush()
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()  # R5 lease is the fallback if SSH cannot clean up.
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    pass


def run(args):
    pygame.init()
    screen = pygame.display.set_mode((1400, 900), pygame.RESIZABLE)
    pygame.display.set_caption("ADS1263 | Unverified raw diagnostic scope")
    font = pygame.font.SysFont("consolas", 19)
    small = pygame.font.SysFont("consolas", 16)
    clock = pygame.time.Clock()
    incoming = queue.Queue(maxsize=8192)
    receiver = Receiver(args.host, args.user, incoming)
    histories = [deque(maxlen=12000), deque(maxlen=12000)]
    totals, failures = [0, 0], [0, 0]
    frozen = None
    window_seconds, auto, y_zoom = 15.0, True, 1.0
    received_at = 0.0
    running, paused = True, False
    started = time.monotonic()
    save_path = ROOT / ".meta/ads1263-diagnostic-view.png"
    status_path = ROOT / ".meta/ads1263-diagnostic-status.json"
    last_save = 0.0
    receiver.start()

    def text(value, x, y, color=TEXT, tiny=False):
        screen.blit((small if tiny else font).render(str(value), True, color), (x, y))

    try:
        while running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_ESCAPE:
                        running = False
                    elif event.key == pygame.K_r:
                        receiver.stop()
                        receiver.join(timeout=4)
                        receiver = Receiver(args.host, args.user, incoming)
                        receiver.start()
                    elif event.key == pygame.K_SPACE:
                        paused = not paused
                        frozen = [list(h) for h in histories] if paused else None
                    elif event.key == pygame.K_a:
                        auto, y_zoom = not auto, 1.0
                    elif event.key in (pygame.K_PLUS, pygame.K_EQUALS, pygame.K_KP_PLUS):
                        window_seconds = max(1, window_seconds / 1.5)
                    elif event.key in (pygame.K_MINUS, pygame.K_KP_MINUS):
                        window_seconds = min(120, window_seconds * 1.5)
                elif event.type == pygame.MOUSEWHEEL:
                    y_zoom = max(0.125, min(128, y_zoom * 1.25 ** event.y))
            while True:
                try:
                    item = incoming.get_nowait()
                except queue.Empty:
                    break
                channel = item["channel"] - 1
                histories[channel].append(item)
                totals[channel] += 1
                failures[channel] += item["spi"] != 0 and not item["waiting"]
                received_at = time.monotonic()

            width, height = screen.get_size()
            screen.fill((13, 20, 29))
            text("ADS1263 / STM DIRECT READ / ADC1 / PGA bypass / SINC1 / ADC setting 4800 SPS", 24, 18)
            text("UNVERIFIED decode - not calibrated sensor values; not stored as production data", 24, 48, RED)
            age = time.monotonic() - received_at if received_at else None
            link = receiver.status if age is None or age < 2 else f"STALE: last readout {age:.1f}s ago"
            text(f"{link}   UI 30 fps   {'PAUSED VIEW' if paused else 'LIVE VIEW'}   queue drops {receiver.dropped}", 24, 77, MUTED, True)
            text(f"SPACE pause | A scale ({'AUTO' if auto else 'FULL'}) | +/- time ({window_seconds:.1f}s) | wheel Y ({y_zoom:g}x) | R reconnect | ESC stop", 24, 102, MUTED, True)
            shown = frozen if paused else histories
            end = max((h[-1]["t_us"] / 1e6 for h in shown if h), default=0)
            start = end - window_seconds
            panel_height = max(210, (height - 165) // 2)
            hover = None
            for channel, history in enumerate(shown):
                y0 = 139 + channel * panel_height
                pygame.draw.rect(screen, (20, 31, 44), (16, y0, width - 32, panel_height - 10), border_radius=8)
                title = ("CH1 / ADC1 / requested AIN0-AIN1 / strain" if channel == 0
                         else "CH2 / ADC1 / requested AIN6-AIN7 / thermo")
                text(title, 30, y0 + 10)
                visible = [p for p in history if p["t_us"] / 1e6 >= start]
                values = [p["raw"] for p in visible if p["raw"] is not None]
                lo, hi = (min(values), max(values)) if auto and values else (-(2 ** 31), 2 ** 31 - 1)
                center = (lo + hi) / 2
                half = max(1, (hi - lo) * .6) / y_zoom
                lo, hi = center - half, center + half
                plot = pygame.Rect(155, y0 + 74, max(100, width - 190), max(75, panel_height - 157))
                for tick in range(5):
                    y = plot.top + tick * plot.height / 4
                    pygame.draw.line(screen, (45, 61, 78), (plot.left, y), (plot.right, y))
                    text(f"{hi - tick * (hi-lo)/4: .5g}", 25, y - 8, MUTED, True)
                    x = plot.left + tick * plot.width / 4
                    pygame.draw.line(screen, (36, 50, 66), (x, plot.top), (x, plot.bottom))
                    text(f"{-window_seconds + tick * window_seconds/4:.1f}s", x - 18, plot.bottom + 4, MUTED, True)
                points = []
                screen.set_clip(plot)
                previous = None
                for item in visible:
                    if item["raw"] is None:
                        previous = None
                        continue
                    x = plot.left + (item["t_us"]/1e6 - start) / window_seconds * plot.width
                    y = plot.bottom - (item["raw"] - lo) / (hi - lo) * plot.height
                    point = (int(x), int(max(plot.top-1000, min(plot.bottom+1000, y))))
                    ok = item["spi"] == 0 and item["configured"] and item["mux_written"] and item["drdy_low"]
                    color = GREEN if ok else RED
                    if previous:
                        pygame.draw.line(screen, color if previous[1] else RED, previous[0], point, 1)
                    pygame.draw.circle(screen, color, point, 2)
                    previous = (point, ok)
                    points.append((point, item))
                screen.set_clip(None)
                if history:
                    item = history[-1]
                    seconds = (history[-1]["t_us"] - history[0]["t_us"]) / 1e6
                    rate = (len(history)-1)/seconds if seconds > 0 else 0
                    reads = sum(p["read_attempted"] and p["spi"] == 0 for p in history)
                    read_rate = reads / seconds if seconds > 0 else 0
                    state = "WAITING DRDY" if item["waiting"] else f"SPI {item['spi']}"
                    text(f"raw {str(item['raw']):>12}   {state}   IO errors {failures[channel]}   {read_rate:.1f} reads/s", 30, y0+40, MUTED, True)
                    rx_text = item['rx'] if item['read_attempted'] else ("WAITING - same MUX held, no deadline" if item["waiting"] else "MUX transfer failed")
                    text(f"RX: {rx_text}   ADC checksum: NOT READ (STM behavior)", 30, plot.bottom+31, MUTED, True)
                    mux = "write sent (no readback)" if item["mux_written"] else "WRITE FAILED"
                    text(f"MUX {item['mux']:02X}: {mux} | DRDY {'LOW' if item['drdy_low'] else 'HIGH'} | DRDY-paced; {rate:.1f} diagnostic events/s", 30, plot.bottom+53, MUTED, True)
                else:
                    text("Waiting for raw SPI readouts...", 30, y0+40, MUTED, True)
                if points and plot.collidepoint(pygame.mouse.get_pos()):
                    mx, _my = pygame.mouse.get_pos()
                    point, item = min(points, key=lambda p: abs(p[0][0]-mx))
                    pygame.draw.line(screen, TEXT, (point[0], plot.top), (point[0], plot.bottom))
                    hover = f"CH{channel+1} / ADC1 index {item['seq']} | t={item['t_us']/1e6:.6f}s | raw={item['raw']} | RX {item['rx']}"
            text(hover or "No ADC checksum validation. Green = init matched + SPI/DRDY observed, NOT proven sensor accuracy. Sequential ADC1 inputs.", 24, height-23, TEXT, True)
            pygame.display.flip()
            now = time.monotonic()
            if now - last_save >= 3:
                pygame.image.save(screen, str(save_path))
                status_path.write_text(json.dumps(dict(status=link, totals=totals, failed=failures,
                    latest=[h[-1] if h else None for h in histories], dropped=receiver.dropped)), encoding="utf-8")
                last_save = now
            if args.seconds and now - started >= args.seconds:
                running = False
            clock.tick(30)
    finally:
        receiver.stop()
        receiver.join(timeout=4)
        pygame.quit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="192.168.0.240")
    parser.add_argument("--user", default="root")
    parser.add_argument("--seconds", type=float, default=0, help="Bounded run for verification")
    run(parser.parse_args())
