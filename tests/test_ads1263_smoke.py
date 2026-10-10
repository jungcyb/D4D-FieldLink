import struct
import unittest
import zlib

from board.ads1263_smoke import (
    CONTROL_ACK,
    CONTROL_GET_STATUS,
    CONTROL_MAGIC,
    FRAME,
    FRAME_MAGIC,
    make_control,
    capture_passed,
    valid_control,
    valid_frame,
)


class Ads1263ProtocolTest(unittest.TestCase):
    def test_capture_requires_both_adc_updates_and_integrity(self) -> None:
        self.assertTrue(capture_passed(3, 400, 10, 0, 0))
        self.assertFalse(capture_passed(0, 0, 0, 0, 0))
        self.assertFalse(capture_passed(3, 0, 0, 0, 0))
        self.assertFalse(capture_passed(3, 400, 0, 0, 0))
        self.assertFalse(capture_passed(3, 400, 10, 1, 0))
        self.assertFalse(capture_passed(3, 400, 10, 0, 1))
        self.assertTrue(capture_passed(1, 0, 0, 0, 0, stopping=True))
        self.assertFalse(capture_passed(3, 0, 0, 0, 0, stopping=True))

    def test_control_round_trip(self) -> None:
        packet = make_control(CONTROL_GET_STATUS, 42)
        self.assertTrue(valid_control(packet))
        self.assertEqual(CONTROL_MAGIC, struct.unpack_from("<I", packet)[0])

        broken = packet[:-1] + bytes([packet[-1] ^ 1])
        self.assertFalse(valid_control(broken))

    def test_frame_crc(self) -> None:
        packet = FRAME.pack(
            FRAME_MAGIC, 2, 1, 0x40, 7, 123456, -10, -2147483648,
            0xF, 50, 50, 1, 2, 0,
        )
        packet = packet[:-4] + struct.pack("<I", zlib.crc32(packet[:-4]))
        self.assertEqual(48, len(packet))
        self.assertTrue(valid_frame(packet))
        legacy = bytearray(packet)
        struct.pack_into("<H", legacy, 4, 1)
        struct.pack_into("<I", legacy, 44, zlib.crc32(legacy[:-4]))
        self.assertFalse(valid_frame(legacy))

    def test_ack_is_not_a_request_command(self) -> None:
        self.assertNotEqual(CONTROL_GET_STATUS, CONTROL_GET_STATUS | CONTROL_ACK)


if __name__ == "__main__":
    unittest.main()
