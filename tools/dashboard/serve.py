#!/usr/bin/env python3
"""Serve the engineering docs and collect live dashboard data locally."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import signal
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--repository", type=Path, default=ROOT)
    parser.add_argument("--ref", default="origin/codex/portomatic-runtime-v0")
    parser.add_argument("--no-collect", action="store_true", help="Read existing data without GitHub access")
    args = parser.parse_args()
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT / "docs"))
    # Bind before spawning the collector so an occupied port cannot leave an orphan.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    collector = None

    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        if not args.no_collect:
            collector = subprocess.Popen([
                sys.executable, str(ROOT / "tools/dashboard/dashboard.py"),
                "--repository", str(args.repository.resolve()), "--ref", args.ref,
            ])
        print(f"Documentation: http://127.0.0.1:{server.server_port}/", flush=True)
        print(f"Implementation: http://127.0.0.1:{server.server_port}/implementation-v0.html", flush=True)
        server.timeout = 1
        while True:
            server.handle_request()
            if collector is not None and collector.poll() is not None:
                print("Dashboard collector exited; restart docs:dev after resolving the error above.", file=sys.stderr)
                return 1
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
        if collector is not None and collector.poll() is None:
            collector.terminate()
            try:
                collector.wait(timeout=10)
            except subprocess.TimeoutExpired:
                collector.kill()
                collector.wait()


if __name__ == "__main__":
    raise SystemExit(main())
