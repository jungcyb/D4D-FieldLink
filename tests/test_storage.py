from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
from collections import namedtuple
import uuid
import zlib


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "board"))
import ads8688d


def frame(sequence: int, rate: int = 1000) -> bytes:
    data = ads8688d.FRAME.pack(
        ads8688d.FRAME_MAGIC, 1, 28, sequence, sequence * 1000,
        rate, 8, 1, *([sequence] * 8), 0,
    )
    return data[:-4] + struct.pack("<I", zlib.crc32(data[:-4]))


class SegmentRingTests(unittest.TestCase):
    def test_rpmsg_burst_drains_pending_packets_but_is_bounded(self):
        server = ads8688d.Server.__new__(ads8688d.Server)
        server.rpmsg = 123
        server._rpmsg_packet = Mock()
        with patch('ads8688d.os.read', side_effect=[b'one', b'two', BlockingIOError]):
            server._rpmsg_read()
        self.assertEqual(server._rpmsg_packet.call_count, 2)
        with patch('ads8688d.os.read', return_value=b'busy') as reader:
            server._rpmsg_read()
        self.assertEqual(reader.call_count, 64)

    def test_rpmsg_frame_batch_is_split_without_losing_order(self):
        server = ads8688d.Server.__new__(ads8688d.Server)
        server._rpmsg_packet = Mock(wraps=server._rpmsg_packet)
        server.pending = {}
        server.scan_rate = 1000
        server.last_sequence = None
        server.frames_total = server.report_frames = 0
        server.gaps_total = server.report_gaps = 0
        server.invalid_total = server.report_invalid = 0
        server._confirm_rate_from_frame = Mock()
        server._publish_frames = Mock()

        server._rpmsg_packet(b"".join(frame(sequence) for sequence in range(1, 5)))

        self.assertEqual(server.frames_total, 4)
        self.assertEqual(server.last_sequence, 4)
        self.assertEqual(server.gaps_total, 0)
        server._publish_frames.assert_called_once()
        self.assertEqual(server._publish_frames.call_args.args[0],
                         [frame(sequence) for sequence in range(1, 5)])

    def test_eleven_channels_report_independent_rates_and_groups(self) -> None:
        capabilities = ads8688d.channel_capabilities(1250)
        self.assertEqual(capabilities["channelCount"], 11)
        self.assertEqual(
            [channel["sampleRateHz"] for channel in capabilities["channels"]],
            [1250] * 8 + [104] * 3,
        )
        writable = [group for group in capabilities["sampleRateGroups"]
                    if group["writable"]]
        self.assertEqual(writable[0]["channelIds"], [f"CH{i}" for i in range(8)])

    def test_rate_frame_confirms_control_even_when_ack_is_delayed(self) -> None:
        server = ads8688d.Server.__new__(ads8688d.Server)
        stream = object()
        server.pending = {7: (stream, ads8688d.MSG_SET_RATE_GROUP, 99, 0.0, 1500)}
        server.clients = {stream: object()}
        server.scan_rate = 1000
        server.acquiring = True
        server.nu40_status = {"state": "streaming", "rate_hz": 104}
        server.last_sequence = None
        server.frames_total = server.report_frames = 0
        server.gaps_total = server.report_gaps = 0
        server.invalid_total = server.report_invalid = 0
        server._response = Mock()
        server._publish_frames = Mock()

        server._rpmsg_packet(frame(1, 1500))

        self.assertFalse(server.pending)
        self.assertEqual(server.scan_rate, 1500)
        server._response.assert_called_once()
        self.assertEqual(server._response.call_args.args[3]["scan_rate_hz"], 1500)

    @patch("ads8688d.shutil.disk_usage", return_value=namedtuple("DiskUsage", "total used free")(1000000, 100000, 900000))
    def test_fifo_and_backlog(self, _disk_usage) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            segment_bytes = ads8688d.SEGMENT_HEADER.size + 2 * ads8688d.RECORD.size
            ring = ads8688d.SegmentRing(
                Path(temporary), uuid.uuid4(), segment_bytes,
                2 * segment_bytes, 0,
            )
            for sequence in range(1, 8):
                record_id, received_ns = ring.append(frame(sequence))
                self.assertEqual(record_id, sequence)
                self.assertGreater(received_ns, 0)
            ring.close()

            self.assertEqual(ring.info()["earliest_record_id"], 5)
            self.assertEqual(ring.info()["latest_record_id"], 7)
            self.assertEqual(
                [record[0] for record in ring.read_after(4, 10)],
                [5, 6, 7],
            )

    @patch("ads8688d.shutil.disk_usage", return_value=namedtuple("DiskUsage", "total used free")(1000000, 100000, 900000))
    def test_batch_append_preserves_records_across_segments(self, _disk_usage) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            segment_bytes = ads8688d.SEGMENT_HEADER.size + 2 * ads8688d.RECORD.size
            ring = ads8688d.SegmentRing(Path(temporary), uuid.uuid4(),
                                        segment_bytes, 0, 0)
            records = ring.append_many([frame(i) for i in range(1, 5)])
            self.assertEqual([record[0] for record in records], [1, 2, 3, 4])
            self.assertEqual(ring.record_bounds(), (1, 4))
            self.assertEqual([record[0] for record in ring.read_after(0, 10)],
                             [1, 2, 3, 4])
            ring.close()

    def test_part_recovery_restores_next_record_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            identity = uuid.uuid4()
            ring = ads8688d.SegmentRing(directory, identity, 4096, 0, 0)
            for sequence in range(1, 4):
                ring.append(frame(sequence))
            ring.current.close()

            recovered = ads8688d.SegmentRing(directory, identity, 4096, 0, 0)
            self.assertEqual(recovered.info()["latest_record_id"], 3)
            self.assertEqual(recovered.next_record_id, 4)


if __name__ == "__main__":
    unittest.main()
