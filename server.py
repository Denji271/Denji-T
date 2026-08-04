import http.server
import socketserver
import urllib.request
import re
import json
import urllib.parse
import os
import ssl
import traceback

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Same API key as js/config.js
API_KEY = "AIzaSyCNMU85XO9QAN81vv-0pinbbKT4cw79sT8"

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


class TorrentProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        # Quieter logs – skip noisy 404 for chrome devtools probe
        if len(args) >= 1 and ".well-known" in str(args[0]):
            return
        super().log_message(format, *args)

    def _safe_write(self, data: bytes):
        """Write response body; ignore client disconnects."""
        try:
            self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def _safe_end_headers(self):
        try:
            self.end_headers()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)

        if parsed_path.path == "/api/read_text":
            query_params = urllib.parse.parse_qs(parsed_path.query)
            file_id = query_params.get("id", [None])[0]
            torrent_title = query_params.get("title", [""])[0]

            if not file_id:
                try:
                    self.send_response(400)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self._safe_end_headers()
                    self._safe_write(b"Missing file id")
                except Exception:
                    pass
                return

            text_content = ""
            try:
                # 1) Metadata description via API key (fast, reliable)
                meta_url = (
                    f"https://www.googleapis.com/drive/v3/files/{file_id}"
                    f"?fields=description&key={API_KEY}"
                )
                req_meta = urllib.request.Request(
                    meta_url, headers={"User-Agent": "Mozilla/5.0"}
                )
                try:
                    with urllib.request.urlopen(req_meta, context=ssl_ctx, timeout=2.5) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        if data.get("description"):
                            text_content = data["description"].strip()
                except Exception:
                    pass

                # 2) Fallback: direct download (only if description empty)
                if not text_content:
                    uc_url = f"https://drive.google.com/uc?export=download&id={file_id}"
                    req = urllib.request.Request(
                        uc_url,
                        headers={
                            "User-Agent": (
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                "AppleWebKit/537.36 (KHTML, like Gecko) "
                                "Chrome/120.0.0.0 Safari/537.36"
                            )
                        },
                    )
                    try:
                        with urllib.request.urlopen(req, context=ssl_ctx, timeout=3) as response:
                            text_content = response.read().decode("utf-8", errors="ignore")
                    except Exception as e:
                        print(f"Drive uc fallback for {file_id}: {e}")

                match = re.search(
                    r'magnet:\?xt=urn:[^\s"\'<>]+', text_content, re.IGNORECASE
                )
                result_text = match.group(0) if match else text_content.strip()

                if (
                    result_text.startswith("magnet:?")
                    and "&dn=" not in result_text.lower()
                    and torrent_title
                ):
                    result_text += f"&dn={urllib.parse.quote(torrent_title)}"

                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Cache-Control", "no-store")
                    self._safe_end_headers()
                    self._safe_write(result_text.encode("utf-8"))
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
                    # Client aborted (AbortController) – normal, ignore
                    pass
                return

            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                return
            except Exception as e:
                print(f"Drive text error for {file_id}: {e}")
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self._safe_end_headers()
                    self._safe_write(b"")
                except Exception:
                    pass
                return

        return super().do_GET()


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with ThreadedTCPServer(("", PORT), TorrentProxyHandler) as httpd:
        print(f"Denji-T Server running at http://localhost:{PORT}")
        print(f"Serving files from: {DIRECTORY}")
        httpd.serve_forever()
