#!/usr/bin/env python3
"""Servidor local para el dashboard de caudales CELEC."""
import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8765
DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, format, *args):
        print(f"  {self.address_string()} - {format % args}")

if __name__ == "__main__":
    os.chdir(DIR)
    url = f"http://localhost:{PORT}/dashboard.html"
    print(f"Servidor CELEC corriendo en: {url}")
    print("Presiona Ctrl+C para detener.\n")
    webbrowser.open(url)
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")
            sys.exit(0)
