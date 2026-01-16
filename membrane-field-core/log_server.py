"""
Mission-critical logging server for CIEN/FIELD documentation.
Filters noise, keeps only essential state transitions.
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
from datetime import datetime

LOGFILE = "mission_critical.log"

# Only log messages containing these patterns
CRITICAL_PATTERNS = [
    "[Director]",
    "Scenario:",
    "alpha:",
    "Queue phase",
    "Local sim",
    "STARTED",
    "ENDED",
    "Snapped",
    "Transition",
    "Clock montage",
    "Metrics",
    # PHI rebuild diagnostics
    "[LOT FILLS]",
    "[PHI]",
    "[REBUILD",
    "[BUILD]",
    "[SAB",
    "lotDraining",
    "lot admission",
]

class LogHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Silence HTTP logs

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path == "/clear":
            open(LOGFILE, "w").close()
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Log cleared")
            self.send_response(200)
            self._cors()
            self.end_headers()
            return

        if self.path == "/log":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            msg = data.get("msg", "")

            # Filter: only mission-critical
            if any(p in msg for p in CRITICAL_PATTERNS):
                ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                line = f"[{ts}] {msg}"
                print(line)
                with open(LOGFILE, "a") as f:
                    f.write(line + "\n")

            self.send_response(200)
            self._cors()
            self.end_headers()
            return

        self.send_response(404)
        self.end_headers()

if __name__ == "__main__":
    print(f"Mission-critical logger on :9999 -> {LOGFILE}")
    print(f"Patterns: {CRITICAL_PATTERNS}")
    HTTPServer(("", 9999), LogHandler).serve_forever()
