from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
from collections import namedtuple
import uuid
import zlib


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "board"))
import ads8688d


def frame(sequence: int) -> bytes:
    data = ads8688d.FRAME.pack(
        ads8688d.FRAME_MAGIC, 1, 28, sequence, sequence * 1000,
        1000, 8, 1, *([sequence] * 8), 0,
    )
    return data[:-4] + struct.pack("<I", zlib.crc32(data[:-4]))


class SegmentRingTests(unittest.TestCase):
    def test_dual_adc_capabilities_report_rates_and_groups(self) -> None:
        capabilities = ads8688d.channel_capabilities(1250)
        self.assertEqual(capabilities["channelCount"], 10)
        self.assertEqual(
            [channel["sampleRateHz"] for channel in capabilities["channels"]],
            [1250] * 8 + [400, 10],
        )
        writable = [group for group in capabilities["sampleRateGroups"]
                    if group["writable"]]
        self.assertEqual(writable[0]["channelIds"], [f"CH{i}" for i in range(8)])

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
