# pygame ADS8688 client

The client renders eight simultaneous, fixed-scale traces in one resizable
pygame window. It reads the board address from `.meta/client/host.txt` at the
repository root; update that local-only file if the Wi-Fi or Ethernet address changes.

```powershell
python -m venv .venv-client
.\.venv-client\Scripts\python -m pip install pygame
.\.venv-client\Scripts\python .\client\pygame_scope.py
```

After the one-time setup, launch it with `client\run_scope.ps1`. Use
`--host <address>` to override `.meta/client/host.txt`. This file is not committed;
on a fresh clone, create it with one board address or pass `--host` explicitly.

The viewer reconnects automatically. After a disconnect it requests stored
records after its last `record_id`, catches up, and then resumes the live
stream.

The standard-library CLI covers discovery, control, and archived data:

```powershell
python .\client\ads8688_cli.py discover --address 192.168.1.255
python .\client\ads8688_cli.py status
python .\client\ads8688_cli.py set-rate 1000
python .\client\ads8688_cli.py stop
python .\client\ads8688_cli.py start
python .\client\ads8688_cli.py archive-info
python .\client\ads8688_cli.py backlog --after 100000 --limit 2000 --output backlog.bin
```

See `docs/PROTOCOL.md` for the binary protocol and disconnect recovery rules.
