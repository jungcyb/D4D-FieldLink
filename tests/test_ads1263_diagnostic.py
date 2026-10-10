import struct
import unittest
import zlib
from pathlib import Path

from board.ads1263_diag import DIAG, DIAG_MAGIC, DIAG_VERSION, decode_diagnostic
from board.ads1263_smoke import valid_frame


def packet(channel, rx, spi=0, flags=7, version=DIAG_VERSION):
    payload = bytes(rx).ljust(7, b"\0") + bytes([flags])
    data = DIAG.pack(DIAG_MAGIC, version, channel, len(rx), 42, 123456, spi, payload, 0)
    return data[:-4] + struct.pack("<I", zlib.crc32(data[:-4]))


class DiagnosticTest(unittest.TestCase):
    def test_stm_direct_offsets_and_production_separation(self):
        data = packet(1, [0x40, 0x12, 0x34, 0x56, 0x78])
        result = decode_diagnostic(data)
        self.assertEqual(DIAG.size, 36)
        self.assertEqual(result["raw"], 0x12345678)
        self.assertEqual(result["status"], 0x40)
        self.assertIsNone(result["checksum_ok"])
        self.assertTrue(result["read_attempted"])
        self.assertFalse(valid_frame(data))

    def test_raw_is_retained_but_bad_transport_is_rejected(self):
        data = packet(1, [3, 0xFC, 0xF5, 0xF9, 8], flags=6)
        result = decode_diagnostic(data)
        self.assertFalse(result["configured"])
        self.assertEqual(result["raw"], int.from_bytes(bytes.fromhex("fc f5 f9 08"), "big", signed=True))
        self.assertEqual(result["rx"], "03 FC F5 F9 08")
        self.assertIsNone(decode_diagnostic(data[:-1] + bytes([data[-1] ^ 1])))

    def test_second_input_is_also_adc1_signed_32_bit(self):
        result = decode_diagnostic(packet(2, [0x40, 0xFF, 0xFF, 0xFF, 0xFF]))
        self.assertEqual(result["raw"], -1)
        self.assertEqual((result["channel"], result["adc"], result["mux"]), (2, 1, 0x67))
        self.assertTrue(result["mux_written"])
        result = decode_diagnostic(packet(2, [0x40, 0x80, 0, 0, 0]))
        self.assertEqual(result["raw"], -(2 ** 31))

    def test_wait_is_not_a_fake_zero_sample(self):
        result = decode_diagnostic(packet(1, [], spi=-2, flags=2))
        self.assertIsNone(result["raw"])
        self.assertIsNone(result["status"])
        self.assertFalse(result["read_attempted"])
        self.assertTrue(result["waiting"])
        self.assertEqual(result["rx"], "")
        self.assertIsNone(decode_diagnostic(packet(1, [0] * 5, spi=-1))["raw"])
        self.assertEqual(decode_diagnostic(packet(1, [0] * 5, flags=6))["raw"], 0)

    def test_bad_versions_and_lengths_rejected(self):
        self.assertIsNone(decode_diagnostic(packet(3, [0] * 5)))
        for version in (1, 2):
            self.assertIsNone(decode_diagnostic(packet(2, [0] * 5, version=version)))
        for length in (1, 4, 6, 7):
            self.assertIsNone(decode_diagnostic(packet(1, [0] * length)))

    def test_diagnostic_lease_and_no_production_samples(self):
        source = (Path(__file__).resolve().parents[1] / "firmware/r5_ads1263/app.c").read_text()
        self.assertIn("5000000U", source)
        loop = source.split("if (scanPending == 0U)", 1)[1]
        body = loop.rsplit("if (diagnostic != 0U)", 1)[1].split("if ((muxWritten == 0U)", 1)[0]
        self.assertNotIn("ADS1263_FRAME_SAMPLE", body)
        self.assertIn("continue;", body)
        self.assertLess(loop.index("ADS1263_WAIT_REPORT_US"), loop.index("App_sendDiagnostic"))
        wait = loop.split("if ((muxWritten != 0U)", 1)[1].split("continue;", 1)[0]
        self.assertNotIn("scanChannel =", wait)
        self.assertNotIn("scanPending =", wait)
        self.assertNotIn("Ads1263_selectInput", wait)
        self.assertNotIn("Ads1263_stop", wait)

    def test_stm_spi_contract(self):
        root = Path(__file__).resolve().parents[1]
        driver = (root / "firmware/r5_ads1263/ads1263.c").read_text()
        app = (root / "firmware/r5_ads1263/app.c").read_text()
        syscfg = (root / "firmware/r5_ads1263/example.syscfg").read_text()
        self.assertIn('mcspi1.intrEnable                  = "DMA"', syscfg)
        self.assertIn('frameFormat = "POL0_PHA1"', syscfg)
        self.assertIn("0x40U, 0x06U, 0x00U, 0x11U, 0x05U, 0x00U, 0x00U, 0x8BU, 0x0AU", driver)
        self.assertIn("#define ADS1263_CMD_START1 (0x09U)", driver)
        self.assertNotIn("ADS1263_CMD_RDATA", driver)
        self.assertNotIn("ADS1263_CMD_START2", driver)
        selection = driver.split("int32_t Ads1263_selectInput", 1)[1].split("int32_t Ads1263_stop", 1)[0]
        self.assertIn("0x46U, 0x00U, channel == 1U ? 0x01U : 0x67U", selection)
        self.assertNotIn("Ads1263_command(", selection)
        self.assertNotIn("Ads1263_readRegister(", selection)
        read = driver.split("int32_t Ads1263_readRaw", 1)[1].split("int32_t Ads1263_readAdc1", 1)[0]
        self.assertIn("const uint8_t tx[5] = {0U}", read)
        self.assertNotIn("ADS1263_SCAN_SLOT_US", app)
        self.assertIn("if (scanChannel == 1U) pairValid = 0U;", app)
        self.assertIn("if (pairValid == 3U)", app)


if __name__ == "__main__":
    unittest.main()
