#!/usr/bin/env python3
"""
Thermodynamics Heat-Collector Ray-Trace Simulator - local server.

Just run this file (VS Code's Run button, or `python3 server.py`).
It serves this folder over HTTP and opens your browser automatically.
No pip installs required - everything else (Three.js etc.) loads from
a CDN in the browser itself.
"""
import http.server
import socketserver
import webbrowser
import threading
import mimetypes
import os

PORT = 8731
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# make sure .js/.mjs are served with a module-friendly MIME type
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # allow local STL/file access etc. without CORS headaches
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


def main():
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/index.html"
        print(f"Serving the simulator at {url}")
        print("Press Ctrl+C to stop.")
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
