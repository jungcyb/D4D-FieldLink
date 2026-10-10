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


def scan_frame(sequence: int, codes=(1, -2, 3, -4), timeout_mask: int = 0, rate: int = 100) -> bytes:
    data = ads8688d.SCAN_FRAME.pack(
        ads8688d.SCAN_MAGIC, 1, 4, timeout_mask, sequence, sequence * 10000,
        rate, 0x41, 0x41, 0x45, 0x45, *codes, 0,
    )
    return data[:-4] + struct.pack("<I", zlib.crc32(data[:-4]))


class SegmentRingTests(unittest.TestCase):
    def test_dual_adc_capabilities_report_rates_and_groups(self) -> None:
        capabilities = ads8688d.channel_capabilities(1250, 200)
        self.assertEqual(capabilities["channelCount"], 12)
        self.assertEqual(
            [channel["sampleRateHz"] for channel in capabilities["channels"]],
            [1250] * 8 + [200] * 4,
        )
        writable = {group["id"]: group for group in capabilities["sampleRateGroups"]
                    if group["writable"]}
        self.assertEqual(writable["ads8688.scan"]["channelIds"], [f"CH{i}" for i in range(8)])
        self.assertEqual(writable["ads1263.scan"]["channelIds"],
                         ["ADS1263-AIN0_AIN1", "ADS1263-AIN2_AIN3",
                          "ADS1263-AIN4_AIN5", "ADS1263-AIN6_AIN7"])
        self.assertEqual((writable["ads1263.scan"]["minHz"], writable["ads1263.scan"]["maxHz"]), (1, 300))
        # The dashboard collector does not forward ADS1263 yet.
        self.assertFalse(any(channel["streamAvailable"] for channel in capabilities["channels"][8:]))

    def test_scan_frame_validation_and_decoding(self) -> None:
        packet = scan_frame(7, codes=(2**30, -(2**30), 0, 5), timeout_mask=0b0100)
        self.assertEqual(len(packet), 48)
        self.assertTrue(ads8688d.valid_scan_frame(packet))
        self.assertFalse(ads8688d.valid_scan_frame(packet[:-1] + bytes([packet[-1] ^ 1])))
        self.assertFalse(ads8688d.valid_scan_frame(frame(7)))
        decoded = ads8688d.decode_scan_frame(packet)
        self.assertEqual(decoded["sequence"], 7)
        self.assertEqual(decoded["scan_rate_hz"], 100)
        self.assertEqual(decoded["volts"][:2], [1.25, -1.25])
        self.assertIsNone(decoded["volts"][2])

    def test_ads1263_ring_is_separate_from_ads8688(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            identity = uuid.uuid4()
            ring = ads8688d.SegmentRing(directory, identity, 4096, 0, 0, magic=b"A26SSEG\0",
                                        suffix=".a26s", frame_meta=ads8688d.ads1263_meta)
            for sequence in range(1, 4):
                ring.append(scan_frame(sequence))
            ring.close()
            self.assertEqual([record[0] for record in ring.read_after(0, 10)], [1, 2, 3])
            self.assertEqual(ads8688d.SegmentRing(directory, identity, 4096, 0, 0).info()["segments"], 0)

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
