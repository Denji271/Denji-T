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

        # ---- Subtitle file content (SRT/VTT) from Drive ----
        if parsed_path.path == "/api/subtitle":
            query_params = urllib.parse.parse_qs(parsed_path.query)
            file_id = query_params.get("id", [None])[0]
            if not file_id:
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self._safe_end_headers()
                self._safe_write(b"Missing id")
                return
            text_content = ""
            try:
                # Prefer description (if small SRT was stored there)
                meta_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?fields=description&key={API_KEY}"
                req_meta = urllib.request.Request(meta_url, headers={"User-Agent": "Mozilla/5.0"})
                try:
                    with urllib.request.urlopen(req_meta, context=ssl_ctx, timeout=3) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        if data.get("description") and len(data["description"]) > 20:
                            text_content = data["description"]
                except Exception:
                    pass
                # Fallback: direct download
                if not text_content:
                    uc_url = f"https://drive.google.com/uc?export=download&id={file_id}"
                    req = urllib.request.Request(
                        uc_url,
                        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"},
                    )
                    with urllib.request.urlopen(req, context=ssl_ctx, timeout=8) as response:
                        text_content = response.read().decode("utf-8", errors="ignore")
            except Exception as e:
                print(f"Subtitle fetch error {file_id}: {e}")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self._safe_end_headers()
            self._safe_write(text_content.encode("utf-8"))
            return

        # ---- Resolve Streamtape → direct get_video URL ----
        if parsed_path.path == "/api/resolve_stream":
            query_params = urllib.parse.parse_qs(parsed_path.query)
            raw_url = query_params.get("url", [""])[0]
            if not raw_url:
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self._safe_end_headers()
                self._safe_write(b"Missing url")
                return
            direct = self._resolve_streamtape(raw_url)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self._safe_end_headers()
            # Client plays via our proxy to avoid CORS / referer issues
            play = f"/api/proxy_video?url={urllib.parse.quote(direct, safe='')}" if direct else None
            self._safe_write(json.dumps({"url": direct or None, "proxy": play}).encode("utf-8"))
            return

        # ---- Proxy video bytes (Range support for seeking) ----
        if parsed_path.path == "/api/proxy_video":
            query_params = urllib.parse.parse_qs(parsed_path.query)
            target = query_params.get("url", [""])[0]
            if not target or not target.startswith("http"):
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self._safe_end_headers()
                self._safe_write(b"Missing url")
                return
            try:
                headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": "https://streamtape.com/",
                    "Accept": "*/*",
                }
                range_hdr = self.headers.get("Range")
                if range_hdr:
                    headers["Range"] = range_hdr
                req = urllib.request.Request(target, headers=headers)
                with urllib.request.urlopen(req, context=ssl_ctx, timeout=30) as resp:
                    status = resp.status
                    content_type = resp.headers.get("Content-Type", "video/mp4")
                    content_length = resp.headers.get("Content-Length")
                    content_range = resp.headers.get("Content-Range")
                    accept_ranges = resp.headers.get("Accept-Ranges", "bytes")
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
                    self.send_header("Accept-Ranges", accept_ranges)
                    if content_length:
                        self.send_header("Content-Length", content_length)
                    if content_range:
                        self.send_header("Content-Range", content_range)
                    self.send_header("Cache-Control", "no-store")
                    self._safe_end_headers()
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        self._safe_write(chunk)
            except Exception as e:
                print(f"proxy_video error: {e}")
                try:
                    self.send_response(502)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self._safe_end_headers()
                    self._safe_write(str(e).encode("utf-8"))
                except Exception:
                    pass
            return

        return super().do_GET()

    def _resolve_streamtape(self, raw_url):
        """Extract playable get_video URL — evaluates Streamtape's substring obfuscation."""
        try:
            m_id = re.search(r"/(?:v|e|r)/([A-Za-z0-9]+)", raw_url)
            if not m_id:
                return None
            vid = m_id.group(1)
            page_url = f"https://streamtape.com/e/{vid}"
            req = urllib.request.Request(
                page_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": "https://streamtape.com/",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            with urllib.request.urlopen(req, context=ssl_ctx, timeout=12) as resp:
                html = resp.read().decode("utf-8", errors="ignore")

            direct = ""

            # robotlink / botlink / ideoolink:
            # innerHTML = 'prefix' + ('obfuscated...').substring(a).substring(b)
            for el in ("robotlink", "botlink", "ideoolink"):
                m = re.search(
                    rf"""getElementById\(['"]{el}['"]\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(['"]([^'"]+)['"]\)((?:\.substring\(\d+\))+)""",
                    html,
                    re.I,
                )
                if not m:
                    continue
                prefix, payload, subs = m.group(1), m.group(2), m.group(3)
                for sm in re.finditer(r"\.substring\((\d+)\)", subs):
                    payload = payload[int(sm.group(1)) :]
                part = prefix + payload
                if part.startswith("//"):
                    direct = "https:" + part
                elif part.startswith("http"):
                    direct = part
                elif part.startswith("/get_video"):
                    direct = "https://streamtape.com" + part
                elif part.startswith("/"):
                    # e.g. /streamtape.com/get_video?...
                    direct = "https:/" + part
                else:
                    direct = "https://streamtape.com/" + part.lstrip("/")
                if "get_video" in direct and "token=" in direct:
                    break
                direct = ""

            if direct and "stream=1" not in direct:
                direct += ("&" if "?" in direct else "?") + "stream=1"

            direct = (
                direct.replace("https://streamtape.com//streamtape.com", "https://streamtape.com")
                .replace("https:/streamtape.com", "https://streamtape.com")
            )

            if direct and "get_video" in direct and "token=" in direct:
                print(f"resolve_streamtape OK: {direct[:140]}...")
                return direct

            print("resolve_streamtape: no valid link found")
            return None
        except Exception as e:
            print(f"resolve_streamtape error: {e}")
            traceback.print_exc()
            return None



class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with ThreadedTCPServer(("", PORT), TorrentProxyHandler) as httpd:
        print(f"Denji-T Server running at http://localhost:{PORT}")
        print(f"Serving files from: {DIRECTORY}")
        httpd.serve_forever()

