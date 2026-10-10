import unittest

from board.ads1263_scan_test import judge

STARTUP = [
    "[r5f1-0]     0.061000s : ADS1263: regs=[21 11 05 00 80 04 01]",
    "[r5f1-0]     0.072000s : ADS1263: verify MODE0=00 MODE1=00 MODE2=8B INPMUX=0A (expect 00 00 8B 0A)",
]


def scan(status: str = "41", code: int = 12345) -> list[str]:
    return [f"[r5f1-0]     1.0s : ADS1263: ch{ch} status=0x{status} code={code + ch}" for ch in range(4)]


class Ads1263ScanTraceTest(unittest.TestCase):
    def test_healthy_trace_passes(self) -> None:
        ok, report = judge(STARTUP, scan() + scan(code=999))
        self.assertTrue(ok, report)

    def test_wrong_id_or_config_fails(self) -> None:
        self.assertFalse(judge([STARTUP[0].replace("[21", "[FF"), STARTUP[1]], scan())[0])
        self.assertFalse(judge([STARTUP[0], STARTUP[1].replace("8B", "00")], scan())[0])

    def test_missing_channel_or_stale_data_fails(self) -> None:
        self.assertFalse(judge(STARTUP, scan()[:3])[0])
        self.assertFalse(judge(STARTUP, scan(status="01"))[0])
        timeouts = [f"ADS1263: ch{ch} DRDY timeout" for ch in range(4)]
        self.assertFalse(judge(STARTUP, timeouts)[0])

    def test_stuck_bus_fails(self) -> None:
        stuck = [f"ADS1263: ch{ch} status=0x41 code=-1" for ch in range(4)] * 2
        self.assertFalse(judge(STARTUP, stuck)[0])

    def test_firmware_error_fails(self) -> None:
        self.assertFalse(judge(STARTUP + ["ADS1263: SPI handle not opened"], scan())[0])


if __name__ == "__main__":
    unittest.main()
