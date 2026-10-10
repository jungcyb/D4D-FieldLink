from __future__ import annotations
import argparse
import os


def main():
    parser = argparse.ArgumentParser(description="Pygame direct multi-DAQ live console (no web server).")
    parser.add_argument("--host", action="append", default=[], help="DAQ host[:port], repeat for multiple devices")
    parser.add_argument("--broadcast", action="append", default=[], help="LAN broadcast address, repeat for multiple NICs")
    parser.add_argument("--export-dir", help="CSV output directory (default .meta/live_console/exports)")
    parser.add_argument("--seconds", type=float, help="Exit after a bounded verification run")
    parser.add_argument("--screenshot", help="Save the rendered window on exit")
    parser.add_argument("--headless", action="store_true", help="SDL dummy video driver for automated rendering tests")
    args = parser.parse_args()
    if args.headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    from .network import Fleet
    from .app import Console
    hosts = []
    for address in args.host:
        host, separator, port = address.partition(":")
        try:
            port = int(port) if separator else 8765
            if not host or not 1 <= port <= 65535:
                raise ValueError()
        except ValueError:
            parser.error("--host must be host[:port], port 1..65535")
        hosts.append((host, port))
    fleet = Fleet(args.broadcast, hosts)
    try:
        Console(fleet, export_dir=args.export_dir).run(args.seconds, args.screenshot)
    finally:
        fleet.stop()


if __name__ == "__main__":
    main()
