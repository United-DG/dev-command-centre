#!/usr/bin/env python3
"""
PC Audio Daemon for Developer Command Center.

Runs on your local PC (Windows/WSL) and polls the 24/7 backend for alarm
signals. When an alarm is queued (from the dashboard or the hourly reminder
scheduler), it plays a real hardware beep — no manual checking required.

Usage:
    python alarm_daemon.py --server http://192.168.1.50:5000 --interval 10

Run in the background / on boot: see README.md (Windows Task Scheduler).
"""

import argparse
import os
import sys
import time

import requests

# Load a .env file sitting next to this script (optional).
# Falls back gracefully if python-dotenv isn't installed.
try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass


def play_sound(pattern: int = 3):
    """Play a real PC beep. Cross-platform with graceful fallbacks."""
    if sys.platform == "win32":
        import winsound

        for _ in range(pattern):
            winsound.Beep(1000, 400)  # 1000 Hz, 400 ms
            time.sleep(0.15)
    elif sys.platform == "darwin":
        os.system("afplay /System/Library/Sounds/Ping.aiff 2>/dev/null")
    else:
        # Linux/WSL: terminal bell (works in most terminals)
        print("\a" * pattern, end="", flush=True)


def poll_loop(server_url: str, interval: int, token: str | None):
    url = server_url.rstrip("/") + "/api/daemon/check-alarm"
    headers = {"X-Daemon-Token": token} if token else {}
    print(f"PC Audio Daemon started. Polling {url} every {interval}s.")
    print("Press Ctrl+C to stop.")

    while True:
        try:
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200 and res.json().get("sound_alarm"):
                print("\a[ALARM] Signal received — ringing!", flush=True)
                play_sound()
            elif res.status_code == 403:
                print("[ERROR] Server rejected token (DAEMON_TOKEN mismatch). Fix and restart.", flush=True)
                sys.exit(1)
        except requests.RequestException as e:
            print(f"[warn] poll failed: {e}", flush=True)
        except KeyboardInterrupt:
            print("\nDaemon stopped.")
            break
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description="Developer Command Center PC alarm daemon")
    parser.add_argument(
        "--server",
        default=os.environ.get("DCC_SERVER", "http://localhost:5000"),
        help="Backend base URL (env: DCC_SERVER)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=int(os.environ.get("DCC_INTERVAL", "10")),
        help="Poll interval in seconds (env: DCC_INTERVAL)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("DCC_TOKEN"),
        help="Shared secret if backend DAEMON_TOKEN is set (env: DCC_TOKEN)",
    )
    args = parser.parse_args()
    poll_loop(args.server, args.interval, args.token)


if __name__ == "__main__":
    main()
