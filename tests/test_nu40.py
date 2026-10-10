import math
import struct
import unittest
import zlib
from board.nu40 import FRAME, MAGIC, Link, MedianMovingAverage, Parser, RmsDetector, packet


class Nu40Tests(unittest.TestCase):
    def test_median_then_moving_average_matches_esp_order_and_resets(self):
        filter_ = MedianMovingAverage(3, 2)
        self.assertEqual(filter_.update((1, -1, 10)), (1, -1, 10))
        self.assertEqual(filter_.update((100, -100, 20)), (26, -26, 13))
        self.assertEqual(filter_.update((2, -2, 30)), (27, -26, 18))
        self.assertEqual(MedianMovingAverage(3, 2).update((2, -2, 30)), (2, -2, 30))

    def test_fragment_crc_resync(self):
        parser = Parser()
        good = packet(0x40, bytes(16))
        bad = bytearray(good); bad[-1] ^= 1
        self.assertEqual(parser.feed(b'noise' + bad + good[:7]), [])
        self.assertEqual(parser.feed(good[7:]), [(0x40, 0, bytes(16))])
        self.assertGreater(parser.corrupt, 0)

    def link(self):
        sent, events = [], []
        link = Link(sent.append, events.append)
        hello = bytearray(47)
        hello[:4] = bytes((1, 1, 1, 2)); hello[4:12] = b'NU40test'
        struct.pack_into('<H', hello, 12, 1)
        struct.pack_into('<I', hello, 16, 7)
        hello[20] = 3; hello[36] = 10; hello[37:] = b'NU40_ACCEL'
        link.receive(packet(1, hello))
        self.assertEqual(Parser().feed(sent[-1])[0][0], 2)
        link.receive(packet(3, struct.pack('<H', 247) + bytes(10)))
        self.assertEqual(Parser().feed(sent[-1])[0][0], 0x20)
        ack = bytearray(16); struct.pack_into('<I', ack, 4, 104)
        struct.pack_into('<H', ack, 8, 7); ack[11] = 1
        link.receive(packet(0x21, ack))
        link.receive(packet(0x24, b'\x22\x00\x00\x00'))
        return link, events

    def test_handshake_data_units_gap_and_reconnect(self):
        link, events = self.link()
        data = lambda seq: struct.pack('<IQIBBBB6h', seq, 0, 104, 2, 3, 2, 0, -16384, 0, 16384, -1, 2, 3)
        link.receive(packet(0x30, data(100)), 1760000000000000000)
        frames = events[-1]['frames']
        self.assertEqual(len(frames), 2)
        fields = FRAME.unpack(frames[0])
        self.assertEqual(fields[0], MAGIC)
        self.assertEqual(fields[6:11], (3, 2, -16384, 0, 16384))
        second = FRAME.unpack(frames[1])
        self.assertEqual(second[8:11], (-12288, 1, 12289))
        self.assertEqual(fields[-1], zlib.crc32(frames[0][:-4]))
        link.receive(packet(0x30, data(104)), 1760000001000000000)
        self.assertEqual(link.gaps, 2)
        self.assertEqual(link.detector.count, 2)
        self.assertEqual(FRAME.unpack(events[-1]['frames'][0])[8:11], (-16384, 0, 16384))
        self.assertEqual(link.status()['filter']['median_window_samples'], 10)
        link.reset()
        self.assertIsNone(link.status()['anomaly'])
        link.receive(packet(0x30, data(106)))
        self.assertEqual(len(events), 2)

    def test_rms_scores_each_axis_without_gravity_alarm(self):
        rms = RmsDetector(104)
        for i in range(1200):
            rms.update((0, 0, 16384), i)
        self.assertEqual([c['state'] for c in rms.snapshot()['channels']], ['normal'] * 3)
        for i in range(50):
            rms.update((round(8000 * math.sin(i)), 0, 16384), i + 1200)
        self.assertIn(rms.axes[0]['state'], ('warning', 'alarm'))
        self.assertEqual(rms.axes[1]['state'], 'normal')
        self.assertEqual(rms.count, 1250)


if __name__ == '__main__':
    unittest.main()
