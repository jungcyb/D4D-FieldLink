"""Local-only connection settings must not depend on repository-tracked addresses."""
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "client"))
import ads8688_cli as cli


class LocalClientConfigTests(unittest.TestCase):
    def test_reads_host_under_meta(self):
        observed = []
        with patch.object(Path, "exists", lambda path: observed.append(path) or True), patch.object(Path, "read_text", return_value="192.0.2.10\n"):
            self.assertEqual(cli.default_host(), "192.0.2.10")
        self.assertEqual(observed, [ROOT / ".meta" / "client" / "host.txt"])

    def test_missing_local_profile_has_no_hardcoded_board(self):
        with patch.object(Path, "exists", return_value=False):
            self.assertIsNone(cli.default_host())

    def test_missing_host_stops_before_network_command(self):
        error = StringIO()
        with patch.object(Path, "exists", return_value=False), patch.object(sys, "argv", ["ads8688_cli.py", "status"]), patch.object(cli.protocol, "request") as request, redirect_stderr(error):
            with self.assertRaises(SystemExit) as raised:
                cli.main()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn(".meta/client/host.txt", error.getvalue())
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
