#!/usr/bin/env python3
"""
HTTP server with Cross-Origin Isolation headers for SharedArrayBuffer.
Usage: python serve_coi.py [port]

Run from membrane-field-core directory:
  python serve_coi.py 8080

Then open: http://localhost:8080/test/testBundle.html
"""

import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

class COIHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()

    def log_message(self, format, *args):
        # Quieter logging - only show errors
        if args[1][0] != '2':  # Not 2xx status
            super().log_message(format, *args)

class ThreadedHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

print(f"Serving from: {os.getcwd()}")
print(f"URL: http://localhost:{PORT}/test/testBundle.html")
print("crossOriginIsolated: true")
print("Ctrl+C to stop\n")

with ThreadedHTTPServer(("", PORT), COIHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
