#!/usr/bin/env python3
"""Simple log server - Run with: python log_server.py
Then open testBundle.html in browser. Logs written to debug.log
"""

import http.server
import json
from datetime import datetime
from pathlib import Path

LOG_FILE = Path(__file__).parent / "debug.log"
PORT = 9999

class LogHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path == "/clear":
            LOG_FILE.write_text(f"=== Log Cleared: {datetime.now().isoformat()} ===\n\n")
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"cleared")
            return

        if self.path == "/log":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                data = json.loads(body)
                timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                line = f"[{timestamp}] {data['msg']}\n"
                with open(LOG_FILE, "a") as f:
                    f.write(line)
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(b"ok")
            except Exception as e:
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(str(e).encode())
            return

        self.send_response(404)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress default logging

if __name__ == "__main__":
    LOG_FILE.write_text(f"=== Debug Log Started: {datetime.now().isoformat()} ===\n\n")
    print(f"Log server running on http://localhost:{PORT}")
    print(f"Logs will be written to: {LOG_FILE}")
    print("Press Ctrl+C to stop")

    server = http.server.HTTPServer(("", PORT), LogHandler)
    server.serve_forever()
