"""Source-level guard against reintroducing intrusive startup diagnostics.

This checks firmware intent, not electrical timing or the module-end waveform.
"""
from pathlib import Path
import re
import unittest


SOURCE = (Path(__file__).resolve().parents[1]
          / "firmware/r5_ads1263/ads1263.c").read_text(encoding="utf-8")


class Ads1263GpioContractTest(unittest.TestCase):
    def test_pin_diagnostic_only_reads_and_logs(self) -> None:
        body = SOURCE.split("static void Ads1263_logPins", 1)[1]
        body = body.split("{", 1)[1].split("\n}", 1)[0]
        body = re.sub(r'"(?:\\.|[^"\\])*"', '""', body)
        calls = set(re.findall(r"\b(\w+)\s*\(", body))
        self.assertEqual(calls, {"DebugP_log", "GPIO_pinRead", "GPIO_pinOutValueRead"})

    def test_spi_pads_are_not_repurposed_for_diagnostics(self) -> None:
        self.assertNotIn("GPIO_DIRECTION_INPUT", SOURCE)
        self.assertNotIn("PIN_SPI1_CLK", SOURCE)
        self.assertNotIn("PIN_SPI1_D0", SOURCE)
        self.assertNotIn("PIN_SPI1_D1", SOURCE)
        self.assertNotIn("Ads1263_probeGpio", SOURCE)
        self.assertIn("GPIO_setDirMode(CSL_GPIO1_BASE, 47U, GPIO_DIRECTION_OUTPUT)", SOURCE)

    def test_hardware_reset_precedes_first_spi_read(self) -> None:
        reset = SOURCE.split("int32_t Ads1263_resetAndConfigure", 1)[1]
        reset = reset.split("Ads1263_transfer", 1)[0]
        expected = (
            "GPIO_pinWriteLow(device->resetGpioBase, device->resetGpioPin)",
            "ClockP_usleep(1000U)",
            "GPIO_pinWriteHigh(device->resetGpioBase, device->resetGpioPin)",
            "ClockP_usleep(60000U)",
            "Ads1263_logPins(device)",
        )
        positions = [reset.index(step) for step in expected]
        self.assertEqual(positions, sorted(positions))


if __name__ == "__main__":
    unittest.main()
