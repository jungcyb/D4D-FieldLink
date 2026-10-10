"""Pygame operator console. All DAQ I/O lives outside the rendering thread."""
from __future__ import annotations

from bisect import bisect_left
import csv
from datetime import datetime
from functools import lru_cache
import os
from pathlib import Path
import re
import threading
import time

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
import pygame

from .model import envelope, limits, validate_rate, visible_rows

# Fluent-inspired light surfaces; these are pygame controls, not native WinUI.
BG = (243, 243, 243)
PANEL = (255, 255, 255)
RAISED = (250, 250, 250)
EDGE = (222, 225, 229)
TEXT = (31, 35, 40)
MUTED = (98, 105, 115)
ACCENT = (0, 95, 184)
GREEN = (16, 124, 65)
AMBER = (145, 94, 0)
RED = (190, 43, 57)
COLORS = (ACCENT, (0, 132, 121), (124, 70, 177), (174, 109, 0),
          (0, 126, 164), (197, 78, 37), (88, 128, 42), (171, 55, 131),
          (36, 108, 176), (157, 78, 165), (23, 139, 118))
ROOT = Path(__file__).resolve().parents[1]


class Console:
    def __init__(self, fleet, size=(1480, 940), export_dir=None):
        pygame.display.init()
        pygame.font.init()
        self.screen = pygame.display.set_mode(size, pygame.RESIZABLE)
        pygame.display.set_caption("FIELDLINK | Live Console — Direct DAQ")
        self.fonts = {size: pygame.font.SysFont("malgungothic,notosanscjkkr,segoeui", size) for size in (12, 14, 16, 18, 22, 26)}
        self.mono = pygame.font.SysFont("consolas,dejavusansmono", 20)
        self.fleet = fleet
        self.selected = 0
        self.channel = 0
        self.sidebar_scroll = 0
        self.seconds = 2.0
        self.offset = 0.0
        self.auto = True
        self.paused = False
        self.frozen = []
        self.detail = False
        self.modal = None
        self.hits = []
        self.plots = []
        self.running = True
        self.notice = "읽기 전용 연결 · 수집 제어는 확인 후 실행됩니다."
        self.notice_until = time.monotonic() + 8
        self.export_dir = Path(export_dir or ROOT / ".meta/live_console/exports")
        self.exporting = False
        self.last_click = (None, 0.0)
        self.data_event = pygame.event.custom_type()
        self.wake_lock = threading.Lock()
        self.wake_pending = False
        self.closed = False
        self.fleet.on_change = self.wake

    def wake(self):
        """Thread-safe notification. At most one data event awaits rendering."""
        with self.wake_lock:
            if self.closed or self.wake_pending:
                return
            try:
                self.wake_pending = pygame.event.post(pygame.event.Event(self.data_event))
            except pygame.error:
                # A full SDL queue still causes the main loop to render latest data.
                self.wake_pending = False

    @lru_cache(maxsize=2048)
    def glyph(self, text, size, color):
        return self.fonts[size].render(text, True, color)

    def text(self, value, x, y, size=14, color=TEXT, width=None):
        value = str(value)
        if width is not None:
            while value and self.fonts[size].size(value)[0] > width:
                value = value[:-2] + "…" if len(value) > 2 else ""
        self.screen.blit(self.glyph(value, size, color), (int(x), int(y)))

    def button(self, label, rect, action, active=False, enabled=True, danger=False):
        rect = pygame.Rect(rect)
        hover = rect.collidepoint(pygame.mouse.get_pos()) and enabled
        color = (226, 239, 251) if active else (255, 245, 246) if danger else PANEL
        pygame.draw.rect(self.screen, color if enabled else PANEL, rect, border_radius=5)
        pygame.draw.rect(self.screen, ACCENT if active else (RED if danger else EDGE), rect, 1, border_radius=5)
        if hover:
            pygame.draw.rect(self.screen, MUTED, rect, 1, border_radius=5)
        label_color = ACCENT if active else RED if danger and enabled else TEXT if enabled else (165, 168, 175)
        self.text(label, rect.x + 10, rect.y + (rect.h-20)//2, color=label_color, width=rect.w-16)
        if enabled:
            self.hits.append((rect, action))

    def notify(self, message):
        self.notice, self.notice_until = str(message), time.monotonic() + 8
        self.wake()

    def current(self):
        sessions = self.fleet.all()
        return sessions[min(self.selected, len(sessions)-1)] if sessions else None

    def choose(self, index):
        self.selected, self.paused, self.frozen, self.offset = index, False, [], 0.0

    def freeze(self):
        session = self.current()
        if self.paused:
            self.paused, self.frozen, self.offset = False, [], 0.0
        elif session:
            self.frozen = session.snapshot(samples=True)["rows"]
            self.paused = True

    def zoom(self, factor):
        if not self.paused:
            self.freeze()
        self.seconds = min(10, max(.05, self.seconds * factor))

    def pan(self, direction):
        if not self.paused:
            self.freeze()
        duration = (max(row.time_ns for row in self.frozen)-min(row.time_ns for row in self.frozen))/1e9 if self.frozen else 0
        self.offset = min(max(0, duration-self.seconds), max(0, self.offset + direction*self.seconds*.4))

    def open_modal(self, kind, **kwargs):
        self.modal = {"kind": kind, "input": "", "error": "", **kwargs}
        pygame.key.start_text_input()

    def close_modal(self):
        self.modal = None
        pygame.key.stop_text_input()

    def control_modal(self, action):
        session = self.current()
        if not session:
            return
        state = session.snapshot()
        if action == "rate":
            groups = [g for g in state["caps"].get("sampleRateGroups", []) if g.get("writable") is True]
            if not groups:
                return
            self.open_modal("rate", session=session, groups=groups, group=0, input=str(groups[0].get("currentHz", "")))
        else:
            self.open_modal("confirm", session=session, action=action)

    def submit(self):
        modal = self.modal
        if not modal:
            return
        try:
            if modal["kind"] == "add":
                address = modal["input"].strip()
                host, separator, port = address.partition(":")
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.\-]{0,252}", host):
                    raise ValueError("IPv4 주소 또는 호스트명을 입력하세요.")
                port = int(port) if separator else 8765
                if not 1 <= port <= 65535:
                    raise ValueError("TCP 포트는 1–65535 범위입니다.")
                session = self.fleet.add({"ip": host, "tcp_port": port})
                session.connect_enabled(True)
                self.choose(self.fleet.all().index(session))
            elif modal["kind"] in ("confirm", "rate"):
                group = modal["groups"][modal["group"]] if modal["kind"] == "rate" else None
                value = validate_rate(group, modal["input"]) if group else None
                action = "rate" if group else modal["action"]
                if not modal["session"].control(action, group["id"] if group else None, value):
                    raise ValueError("연결 상태를 확인하세요. 다른 명령이 처리 중일 수 있습니다.")
                self.notify("명령 전송 중 · ACK와 상태 재조회 결과는 장치 이벤트에 표시됩니다.")
            self.close_modal()
        except (ValueError, OSError) as error:
            modal["error"] = str(error)

    def export(self, state, rows):
        if self.exporting or not rows:
            return
        self.exporting = True
        channels = [c for c in self.channels(state) if self.wire_index(c) is not None]
        destination = self.export_dir / f"{state['uuid'] or 'daq'}-{datetime.now():%Y%m%d-%H%M%S-%f}.csv"

        def write():
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("x", newline="", encoding="utf-8-sig") as stream:
                    writer = csv.writer(stream)
                    writer.writerow(["daq_uuid", "record_id", "sequence", "received_unix_ns", "device_us", "scan_rate_hz", "segment"] + [f"{c['id']}_{kind}" for c in channels for kind in ("code", c.get("inputUnit") or "value")])
                    for row in rows:
                        values = []
                        for channel in channels:
                            index = self.wire_index(channel)
                            values.extend((row.raw(index), row.value(index)) if row.contains(index) else ("", ""))
                        writer.writerow([state["uuid"], row.record, row.sequence, row.unix_ns or "", row.device_us, row.rate, row.segment] + values)
                self.notify(f"CSV 저장 완료 · {len(rows):,} scans · {destination.name}")
            except OSError as error:
                self.notify(f"CSV 저장 실패: {error}")
            finally:
                self.exporting = False
        threading.Thread(target=write, name="csv-export", daemon=True).start()

    @staticmethod
    def channels(state):
        channels = state["caps"].get("channels")
        if channels is not None:
            return channels
        return [{"id": f"CH{i}", "label": f"CH{i} (legacy)", "streamAvailable": True} for i in range(8)]

    @staticmethod
    def wire_index(channel):
        match = re.fullmatch(r"CH(10|[0-9])", channel.get("id", ""))
        return int(match[1]) if match and channel.get("streamAvailable") is True else None

    def handle(self, event):
        if event.type == pygame.QUIT:
            self.running = False
        elif event.type == pygame.VIDEORESIZE:
            self.screen = pygame.display.set_mode((max(1160, event.w), max(760, event.h)), pygame.RESIZABLE)
        elif event.type == pygame.TEXTINPUT and self.modal and self.modal["kind"] in ("add", "rate"):
            self.modal["input"] = (self.modal["input"] + event.text)[:260]
        elif event.type == pygame.KEYDOWN:
            if self.modal:
                if event.key == pygame.K_ESCAPE:
                    self.close_modal()
                elif event.key == pygame.K_RETURN:
                    self.submit()
                elif event.key == pygame.K_BACKSPACE:
                    self.modal["input"] = self.modal["input"][:-1]
                elif event.key == pygame.K_a and event.mod & pygame.KMOD_CTRL:
                    self.modal["input"] = ""
                return
            if event.key == pygame.K_ESCAPE:
                if self.detail:
                    self.detail = False
                else:
                    self.running = False
            elif event.key == pygame.K_SPACE:
                self.freeze()
            elif event.key == pygame.K_a:
                self.auto = not self.auto
            elif event.key == pygame.K_f:
                self.detail = not self.detail
            elif event.key == pygame.K_F5:
                self.fleet.scan_now.set()
            elif event.key == pygame.K_TAB and self.fleet.all():
                self.choose((self.selected+1) % len(self.fleet.all()))
            elif event.key in (pygame.K_EQUALS, pygame.K_KP_PLUS):
                self.zoom(.5)
            elif event.key in (pygame.K_MINUS, pygame.K_KP_MINUS):
                self.zoom(2)
            elif event.key == pygame.K_LEFT:
                self.pan(1)
            elif event.key == pygame.K_RIGHT:
                self.pan(-1)
        elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            for rect, action in reversed(self.hits):
                if rect.collidepoint(event.pos):
                    action()
                    break
        elif event.type == pygame.MOUSEWHEEL and not self.modal:
            if pygame.mouse.get_pos()[0] < 250:
                self.sidebar_scroll = max(0, min(max(0, len(self.fleet.all())-4), self.sidebar_scroll-event.y))
            elif any(rect.collidepoint(pygame.mouse.get_pos()) for rect in self.plots):
                self.zoom(1 / 1.4 if event.y > 0 else 1.4)

    def draw_sidebar(self, snapshots, height):
        pygame.draw.rect(self.screen, (248, 248, 248), (0, 64, 248, height-64))
        pygame.draw.line(self.screen, EDGE, (248, 64), (248, height))
        self.text("DAQ FLEET", 20, 88, 14, MUTED)
        self.text(f"{sum(s['link']=='online' for s in snapshots):02d}", 20, 110, 26, GREEN)
        self.text(f"/ {len(snapshots):02d}  연결됨", 68, 123, 14, MUTED)
        self.button("탐색 중…" if self.fleet.scanning else "다시 탐색", (16, 164, 104, 34), self.fleet.scan_now.set)
        self.button("직접 연결 +", (126, 164, 106, 34), lambda: self.open_modal("add"))
        available = max(1, (height-390)//88)
        self.sidebar_scroll = min(self.sidebar_scroll, max(0, len(snapshots)-available))
        for i, state in enumerate(snapshots[self.sidebar_scroll:self.sidebar_scroll+available], self.sidebar_scroll):
            y = 215 + (i-self.sidebar_scroll)*88
            rect = pygame.Rect(12, y, 224, 78)
            pygame.draw.rect(self.screen, (230, 239, 248) if i == self.selected else PANEL, rect, border_radius=6)
            pygame.draw.rect(self.screen, EDGE, rect, 1, border_radius=6)
            if i == self.selected:
                pygame.draw.rect(self.screen, ACCENT, (rect.x, rect.y+19, 3, 40), border_radius=2)
            online = state["link"] == "online"
            color = GREEN if online else AMBER if state["enabled"] else MUTED
            pygame.draw.circle(self.screen, color, (28, y+19), 4)
            self.text(state["label"], 41, y+8, 16, width=180)
            self.text(f"{state['host']}:{state['port']}", 24, y+33, 12, MUTED)
            age = time.monotonic()-state["last_receive"] if state["last_receive"] else 999
            self.text(f"{state['link'].upper()} · {state['rx_rate'] if age<2 else 0:,.0f} scans/s", 24, y+53, 12, color)
            self.hits.append((rect, lambda index=i: self.choose(index)))
        if not snapshots:
            self.text("발견된 장치가 없습니다", 22, 238, 14, MUTED)
            self.text("같은 LAN / UDP 8764 확인", 22, 264, 12, MUTED)
            self.text("직접 연결로 IP를 입력하세요", 22, 288, 12, MUTED)
        self.text(self.fleet.message, 18, height-142, 12, MUTED, 214)
        self.text("DIRECT CONNECTION", 18, height-110, 12, GREEN)
        self.text("TCP 8765  /  UDP 8764", 18, height-86, 12, MUTED)
        self.text("선택하지 않은 DAQ도 계속 수신", 18, height-62, 12, MUTED)

    def plot(self, rect, rows, channel, state, color):
        index = self.wire_index(channel)
        rows = [row for row in rows if index is not None and row.contains(index)]
        pygame.draw.rect(self.screen, PANEL, rect, border_radius=6)
        pygame.draw.rect(self.screen, color if self.channel == index else EDGE, rect, 1, border_radius=8)
        channel_id = channel["id"]
        diagnosis = next((c for c in state["anomaly"].get("channels", []) if isinstance(c, dict) and c.get("id") == channel_id), {})
        verdict = diagnosis.get("state", "")
        alert_color = RED if verdict == "alarm" else AMBER if verdict in ("warning", "warmup") else GREEN
        self.text(channel_id, rect.x+14, rect.y+9, 16, color)
        sample_rate = channel.get("sampleRateHz", rows[-1].rate if rows else None)
        label = (f"{sample_rate/1000:g}k SPS" if sample_rate >= 1000 else f"{sample_rate:g} SPS") if isinstance(sample_rate, (int, float)) else "SPS —"
        self.text(label, rect.x+62, rect.y+11, 12, MUTED, max(0, rect.w-164))
        if verdict:
            self.text(verdict.upper(), rect.right-90, rect.y+11, 12, alert_color)
        if not rows or index is None:
            self.text("데이터 대기" if index is not None else "현재 프로토콜에서 전송되지 않는 채널", rect.x+20, rect.centery, 14, MUTED)
            return
        unit = channel.get("inputUnit") or rows[-1].unit(index)
        value = rows[-1].value(index)
        self.screen.blit(self.mono.render(f"{value:+.6f} {unit}", True, TEXT), (rect.x+14, rect.y+34))
        if rect.w > 340:
            self.text(channel.get("label", ""), rect.x+210, rect.y+37, 12, MUTED, rect.w-230)
        compact = rect.h < 155
        area = pygame.Rect(rect.x+66, rect.y+61, rect.w-82, max(16, rect.h-(83 if compact else 101)))
        self.plots.append(area)
        display_rows = envelope(rows, index, area.w)
        values = [row.value(index) for row in display_rows]
        low, high = limits(values, self.auto, 2.0 if unit == "g" else 10.24)
        end = self.plot_end
        ticks = 2 if compact else 4
        for tick in range(ticks+1):
            y = area.y + area.h*tick/ticks
            pygame.draw.line(self.screen, (226, 231, 236), (area.x, y), (area.right, y))
            self.text(f"{high-(high-low)*tick/ticks:.5g}", rect.x+8, y-7, 12, MUTED, 56)
            x = area.x + area.w*tick/ticks
            pygame.draw.line(self.screen, (237, 240, 243), (x, area.y), (x, area.bottom))
            if self.detail or tick in (0, ticks//2, ticks):
                self.text(f"{(-self.seconds+self.seconds*tick/ticks):g}s", x-16, area.bottom+3, 12, MUTED)
        old_clip = self.screen.get_clip()
        self.screen.set_clip(area)
        segment, points = None, []

        def stroke():
            if len(points) > 1:
                pygame.draw.lines(self.screen, color, False, points, 1)
            elif points:
                pygame.draw.circle(self.screen, color, points[0], 2)

        for row, value in zip(display_rows, values):
            if segment != row.segment:
                stroke()
                points = []
                segment = row.segment
            x = area.right + (row.time_ns/1e9-end) * area.w/self.seconds
            y = area.bottom - (value-low)/(high-low)*area.h
            points.append((x, y))
        stroke()
        self.screen.set_clip(old_clip)
        if not compact:
            self.text(f"MIN {min(values):+.5f}    MAX {max(values):+.5f}    Δ {max(values)-min(values):.5f} {unit}", rect.x+14, rect.bottom-21, 12, MUTED, rect.w-24)
        mouse = pygame.mouse.get_pos()
        if area.collidepoint(mouse):
            target = (end + (mouse[0]-area.right)*self.seconds/area.w)*1e9
            times = [row.time_ns for row in rows]
            pos = min(len(rows)-1, bisect_left(times, target))
            if pos and abs(times[pos-1]-target) < abs(times[pos]-target):
                pos -= 1
            row = rows[pos]
            x = area.right + (row.time_ns/1e9-end)*area.w/self.seconds
            pygame.draw.line(self.screen, MUTED, (x, area.top), (x, area.bottom))
            self.hover = f"{channel_id}  index {pos:,}  record {row.record}  seq {row.sequence}  raw {row.raw(index)}  {row.value(index):+.7f} {unit}"

        def select():
            now = time.monotonic()
            if self.last_click[0] == index and now-self.last_click[1] < .4:
                self.detail = not self.detail
            self.channel = index
            self.last_click = (index, now)
        self.hits.append((rect, select))

    def draw(self):
        width, height = self.screen.get_size()
        self.screen.fill(BG)
        self.hits, self.plots, self.hover = [], [], ""
        pygame.draw.rect(self.screen, (250, 250, 250), (0, 0, width, 64))
        pygame.draw.line(self.screen, EDGE, (0, 63), (width, 63))
        pygame.draw.rect(self.screen, ACCENT, (20, 18, 4, 27), border_radius=2)
        self.text("FIELDLINK", 34, 15, 22)
        self.text("LIVE CONSOLE", 210, 22, 16, MUTED)
        self.text("DIRECT TCP · NO WEB SERVER", 408, 25, 12, GREEN)
        self.text(f"TCP EVENT-DRIVEN   {time.strftime('%H:%M:%S')}", width-292, 23, 14, MUTED)
        sessions = self.fleet.all()
        self.selected = min(self.selected, max(0, len(sessions)-1))
        snapshots = [s.snapshot(samples=i == self.selected and not self.paused) for i, s in enumerate(sessions)]
        self.draw_sidebar(snapshots, height)
        x, w = 270, width-292
        if not snapshots:
            self.text("DAQ에 직접 연결하세요", x+40, 160, 26)
            self.text("UDP 자동 탐색 또는 IP 직접 연결 · 웹 서버 / collector는 필요하지 않습니다.", x+40, 212, 16, MUTED)
            self.text("여러 장치는 동시에 수신하며, 왼쪽 목록에서 표시할 장치를 선택합니다.", x+40, 248, 16, MUTED)
            self.text("보드 수집 설정은 연결만으로 변경하지 않습니다.", x+40, 284, 16, GREEN)
        else:
            state, session = snapshots[self.selected], sessions[self.selected]
            self.text(state["label"], x, 83, 26, width=w-320)
            self.text(f"{state['model']} · {state['host']}:{state['port']}", x, 120, 14, MUTED, w)
            self.button("연결 해제" if state["enabled"] else "재연결", (width-154, 87, 130, 36), lambda: session.connect_enabled(not state["enabled"]))
            age = time.monotonic()-state["last_receive"] if state["last_receive"] else None
            metrics = [("CONNECTION", state["link"].upper(), GREEN if state["link"] == "online" else AMBER),
                       ("RECEIVE RATE", f"{state['rx_rate'] if age is not None and age<2 else 0:,.0f} scans/s", TEXT),
                       ("LAST PACKET", f"{age:.2f} s ago" if age is not None else "WAITING", AMBER if age is None or age>2 else GREEN),
                       ("LOSS / CRC", f"{state['gaps']:,} / {state['bad']:,}", AMBER if state["gaps"] or state["bad"] else TEXT)]
            for i, (title, value, color) in enumerate(metrics):
                r = pygame.Rect(x+i*w//4, 154, w//4-8, 65)
                pygame.draw.rect(self.screen, PANEL, r, border_radius=5)
                self.text(title, r.x+13, r.y+8, 12, MUTED)
                self.text(value, r.x+13, r.y+29, 18, color)
            self.button("화면 재개" if self.paused else "화면 일시정지", (x, 233, 125, 34), self.freeze, active=self.paused)
            for i, seconds in enumerate((1, 2, 5, 10)):
                self.button(f"{seconds}s", (x+137+i*45, 233, 39, 34), lambda s=seconds: setattr(self, "seconds", float(s)), active=self.seconds == seconds)
            self.button("Y 자동" if self.auto else "Y 전체 범위", (x+325, 233, 108, 34), lambda: setattr(self, "auto", not self.auto), active=self.auto)
            self.button("전체 채널 보기" if self.detail else "선택 채널 확대", (x+443, 233, 128, 34), lambda: setattr(self, "detail", not self.detail))
            all_rows = self.frozen if self.paused else state["rows"]
            self.plot_end = max((row.time_ns for row in all_rows), default=0)/1e9-self.offset
            shown = visible_rows(all_rows, self.seconds, self.offset)
            self.button("CSV 저장 중…" if self.exporting else "표시 구간 CSV", (x+581, 233, 130, 34), lambda: self.export(state, list(shown)), enabled=bool(shown) and not self.exporting)
            self.button("?", (width-60, 233, 36, 34), lambda: self.open_modal("help"))
            can_control = "acquisition_control" in state["features"] and state["link"] == "online" and not state["busy"]
            self.button("수집 시작", (x, 281, 94, 32), lambda: self.control_modal("start"), enabled=can_control and state["status"].get("acquiring") is not True)
            self.button("수집 정지", (x+103, 281, 94, 32), lambda: self.control_modal("stop"), enabled=can_control and state["status"].get("acquiring") is True, danger=True)
            writable = any(g.get("writable") is True for g in state["caps"].get("sampleRateGroups", []))
            self.button("SPS 설정", (x+206, 281, 102, 32), lambda: self.control_modal("rate"), enabled=writable and state["link"] == "online" and not state["busy"])
            self.text("보드 제어는 모든 클라이언트에 적용됩니다", x+324, 289, 12, AMBER, w-440)
            if self.paused:
                self.button("←", (width-132, 281, 46, 32), lambda: self.pan(1))
                self.button("→", (width-77, 281, 46, 32), lambda: self.pan(-1))
            channels = self.channels(state)
            supported = [c for c in channels if self.wire_index(c) is not None]
            unsupported = [c["id"] for c in channels if self.wire_index(c) is None]
            note = f"{len(supported)}/{len(channels)} 채널 혼합 스트림 · ADS8688 V / NU40 필터 적용 g · 서버 보정과 독립"
            if unsupported:
                note += " · 전송 미지원: " + ", ".join(unsupported)
            self.text(note, x, 325, 12, MUTED, w)
            if state["error"] and state["link"] != "online":
                self.text("연결 오류: " + state["error"], x, 346, 12, AMBER, w)
            elif self.paused:
                self.text(f"파형만 고정 · 수신/장치 상태는 실시간 · 정지 시점에서 {self.offset:g}초 이전 구간", x, 346, 12, AMBER, w)
            elif age is not None and age > 2:
                self.text("새 샘플 수신 지연 · 아래는 마지막 수신 데이터입니다", x, 346, 12, AMBER, w)
            elif not all_rows:
                self.text("샘플 대기 · 연결만으로 보드 수집을 시작하지 않습니다", x, 346, 12, MUTED, w)
            else:
                self.text("LIVE · TCP 수신 즉시 갱신 / 고정 FPS 제한 없음 · STATUS 2초 · 이력 최대 32,000 scans / DAQ", x, 346, 12, GREEN, w)
            plot_bottom = height-156
            if supported:
                if self.detail:
                    selected = next((c for c in supported if self.wire_index(c) == self.channel), supported[0])
                    self.plot(pygame.Rect(x, 371, w, plot_bottom-371), shown, selected, state, COLORS[self.wire_index(selected)])
                else:
                    columns = 4 if len(supported) > 4 else 2
                    nrows = (len(supported)+columns-1)//columns
                    ph = (plot_bottom-371-(nrows-1)*8)//nrows
                    for i, channel in enumerate(supported):
                        pw = (w-(columns-1)*8)//columns
                        rect = pygame.Rect(x+(i%columns)*(pw+8), 371+(i//columns)*(ph+8), pw, ph)
                        self.plot(rect, shown, channel, state, COLORS[self.wire_index(channel)])
            else:
                self.text("이 장치는 현재 ADS8 라이브 전송 채널을 제공하지 않습니다.", x+20, 420, 18, MUTED)
            self.text(self.hover or "호버: 원본 인덱스·값  /  더블클릭: 채널 확대  /  휠·+/−: 시간 확대  /  ← →: 정지 구간 이동", x, height-144, 12, GREEN if self.hover else MUTED, w)
            pygame.draw.line(self.screen, EDGE, (x, height-118), (width-24, height-118))
            self.text("DEVICE EVENTS", x, height-108, 12, MUTED)
            self.text(f"{state['total']:,} scans  ·  reconnect {state['reconnects']}  ·  restart {state['restarts']}", x+160, height-108, 12, MUTED, w-165)
            for i, (at, message) in enumerate(state["events"][:2]):
                self.text(f"{at}  {message}", x, height-84+i*20, 12, MUTED, w)
        pygame.draw.rect(self.screen, (249, 249, 249), (0, height-30, width, 30))
        pygame.draw.line(self.screen, EDGE, (0, height-30), (width, height-30))
        footer = self.notice if time.monotonic() < self.notice_until else "SPACE 화면 정지  ·  A 자동 스케일  ·  F 채널 확대  ·  TAB 장치 전환  ·  F5 탐색  ·  ESC 닫기 (보드 수집 유지)"
        self.text(footer, 18, height-25, 12, MUTED, width-30)
        if self.modal:
            self.draw_modal()

    def draw_modal(self):
        self.hits = []
        shade = pygame.Surface(self.screen.get_size(), pygame.SRCALPHA)
        shade.fill((0, 0, 0, 175))
        self.screen.blit(shade, (0, 0))
        box = pygame.Rect(0, 0, 680, 370)
        box.center = self.screen.get_rect().center
        pygame.draw.rect(self.screen, PANEL, box, border_radius=10)
        pygame.draw.rect(self.screen, EDGE, box, 1, border_radius=10)
        m = self.modal
        kind = m["kind"]
        title = {"add": "DAQ 직접 연결", "rate": "보드 샘플레이트 변경", "confirm": "보드 수집 상태 변경", "help": "LIVE CONSOLE 사용 안내"}[kind]
        self.text(title, box.x+28, box.y+25, 22)
        if kind == "help":
            lines = ["각 DAQ의 직접 TCP 연결. 웹·collector 없이 동작합니다.",
                     "화면 정지/종료는 보드 수집을 중단하지 않습니다.",
                     "SPACE 정지 · F 선택 채널 확대 · A 자동/전체 스케일",
                     "휠 / + − 시간 확대 · ← → 정지된 이력 이동 · TAB DAQ 전환",
                     "CSV는 현재 표시 구간의 원본 code와 전압(V)을 저장합니다.",
                     "재접속은 최신 LIVE부터 재개하며 과거 누락을 자동 재생하지 않습니다.",
                     "이력은 메모리 한도 내 보관. CRC 오류와 누락은 상태에 표시합니다."]
            for i, line in enumerate(lines):
                self.text(line, box.x+28, box.y+76+i*28, 14, MUTED, box.w-56)
        elif kind == "add":
            self.text("IPv4 주소 또는 호스트명[:포트] · 기본 TCP 8765", box.x+28, box.y+86, 16, MUTED)
            self.text("예: 192.168.1.104:8765   /   신뢰된 LAN 전용", box.x+28, box.y+123, 14, MUTED)
        else:
            state = m["session"].snapshot()
            self.text(f"{state['label']} · {state['host']}:{state['port']}", box.x+28, box.y+76, 16, width=box.w-56)
            self.text(f"UUID {state['uuid']}", box.x+28, box.y+106, 12, MUTED)
            self.text("웹 서버·다른 뷰어를 포함한 모든 클라이언트에 영향을 줍니다.", box.x+28, box.y+141, 14, AMBER)
            if kind == "rate":
                group = m["groups"][m["group"]]
                self.text(f"{group.get('label', group['id'])} · {group.get('minHz', '?')}–{group.get('maxHz', '?')} SPS", box.x+28, box.y+177, 14, width=480)
                self.button("그룹 변경", (box.right-136, box.y+174, 106, 32), self.next_group, enabled=len(m["groups"])>1)
                self.text(", ".join(group["channelIds"]), box.x+28, box.y+206, 12, MUTED, box.w-56)
            else:
                self.text("보드의 데이터 수집을 " + ("시작합니다." if m["action"] == "start" else "정지합니다. 계속할까요?"), box.x+28, box.y+196, 18, AMBER)
        if kind in ("add", "rate"):
            field = pygame.Rect(box.x+28, box.y+(168 if kind == "add" else 231), box.w-56, 40)
            pygame.draw.rect(self.screen, BG, field, border_radius=4)
            pygame.draw.rect(self.screen, ACCENT, field, 1, border_radius=4)
            self.text(m["input"] + ("|" if time.monotonic()%1 < .5 else ""), field.x+10, field.y+8, 16, width=field.w-20)
            if kind == "add":
                self.text("ENTER 연결 · ESC 취소 · Ctrl+A 입력 지우기", box.x+28, box.y+227, 14, MUTED)
        if m["error"]:
            self.text(m["error"], box.x+28, box.bottom-89, 14, RED, box.w-56)
        self.button("닫기" if kind == "help" else "취소", (box.right-260, box.bottom-56, 104, 34), self.close_modal)
        if kind != "help":
            self.button("연결" if kind == "add" else "확인 후 실행", (box.right-144, box.bottom-56, 116, 34), self.submit, danger=kind != "add")

    def next_group(self):
        m = self.modal
        m["group"] = (m["group"]+1)%len(m["groups"])
        m["input"] = str(m["groups"][m["group"]].get("currentHz", ""))

    def run(self, duration=None, screenshot=None):
        started = time.monotonic()
        deadline = started+duration if duration is not None else float("inf")
        next_idle = started
        try:
            while self.running and time.monotonic() < deadline:
                # Idle timeout updates connection age/clock only. A TCP event wakes
                # this wait immediately; there is no frame-rate timer or tick cap.
                timeout = max(1, int((min(next_idle, deadline)-time.monotonic())*1000))
                event = pygame.event.wait(timeout)
                events = [event, *pygame.event.get()]
                with self.wake_lock:
                    self.wake_pending = False
                for event in events:
                    self.handle(event)
                if not self.running:
                    break
                self.draw()
                pygame.display.flip()
                next_idle = time.monotonic()+1
            if screenshot:
                Path(screenshot).parent.mkdir(parents=True, exist_ok=True)
                pygame.image.save(self.screen, str(screenshot))
        finally:
            self.fleet.on_change = None
            with self.wake_lock:
                self.closed = True
            pygame.quit()
