import http.server
import socketserver
import urllib.request
import urllib.parse
import re
import json
import os
import ssl
import traceback

# A felhőszolgáltatók (Render, Fly, Railway…) a PORT változóban adják meg a portot
PORT = int(os.environ.get("PORT", 8080))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Same API key as js/config.js
API_KEY = "AIzaSyCNMU85XO9QAN81vv-0pinbbKT4cw79sT8"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
MAGNET_RE = re.compile(r'magnet:\?xt=urn:[^\s"\'<>]+', re.IGNORECASE)
# Nyilvános szerveren csak ezekre proxyzunk — különben bárki ingyenes proxynak használhatná
VIDEO_HOST_RE = re.compile(r"(^|\.)(streamtape\.[a-z]+|tapecontent\.net)$", re.IGNORECASE)

# A kliens megszakított kérései (AbortController) ezekkel a hibákkal jelentkeznek
CLIENT_GONE = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError)

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


def http_get(url, timeout, extra_headers=None):
    """Egyszerű GET böngésző User-Agenttel; a válaszobjektumot adja vissza."""
    headers = {"User-Agent": BROWSER_UA}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, context=ssl_ctx, timeout=timeout)


class TorrentProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        # Quieter logs – skip noisy 404 for chrome devtools probe
        if len(args) >= 1 and ".well-known" in str(args[0]):
            return
        super().log_message(format, *args)

    def end_headers(self):
        # Helyi kiszolgálás: a böngésző mindig kérje le újra a módosított fájlokat
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def _respond(self, status, body=b"", content_type=None, extra_headers=None):
        """Teljes válasz egy lépésben; a megszakadt kapcsolatot csendben elnyeli."""
        if isinstance(body, str):
            body = body.encode("utf-8")
        try:
            self.send_response(status)
            if content_type:
                self.send_header("Content-Type", content_type)
            self.send_header("Access-Control-Allow-Origin", "*")
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)
        except CLIENT_GONE:
            pass
        except Exception as e:
            print(f"response error: {e}")

    def _drive_text(self, file_id, meta_timeout=2.5, download_timeout=3):
        """Drive szövegfájl tartalma: előbb a description metaadat, aztán a letöltés."""
        try:
            meta_url = (
                f"https://www.googleapis.com/drive/v3/files/{file_id}"
                f"?fields=description&key={API_KEY}"
            )
            with http_get(meta_url, meta_timeout) as resp:
                description = json.loads(resp.read().decode("utf-8")).get("description") or ""
                if description.strip():
                    return description.strip()
        except Exception:
            pass

        try:
            uc_url = f"https://drive.google.com/uc?export=download&id={file_id}"
            with http_get(uc_url, download_timeout) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except Exception as e:
            print(f"Drive uc fallback for {file_id}: {e}")
            return ""

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed_path.query)

        # ---- Szövegfájl (magnet, leírás, kategória…) a Drive-ról ----
        if parsed_path.path == "/api/read_text":
            file_id = params.get("id", [None])[0]
            torrent_title = params.get("title", [""])[0]
            if not file_id:
                return self._respond(400, b"Missing file id")

            try:
                text_content = self._drive_text(file_id)
                match = MAGNET_RE.search(text_content)
                result_text = match.group(0) if match else text_content.strip()

                if (
                    result_text.startswith("magnet:?")
                    and "&dn=" not in result_text.lower()
                    and torrent_title
                ):
                    result_text += f"&dn={urllib.parse.quote(torrent_title)}"
            except Exception as e:
                print(f"Drive text error for {file_id}: {e}")
                result_text = ""

            return self._respond(
                200, result_text,
                content_type="text/plain; charset=utf-8",
                extra_headers={"Cache-Control": "no-store"},
            )

        # ---- Resolve Streamtape → direct get_video URL ----
        if parsed_path.path == "/api/resolve_stream":
            raw_url = params.get("url", [""])[0]
            if not raw_url:
                return self._respond(400, b"Missing url")

            direct = self._resolve_streamtape(raw_url)
            # Client plays via our proxy to avoid CORS / referer issues
            play = f"/api/proxy_video?url={urllib.parse.quote(direct, safe='')}" if direct else None
            return self._respond(
                200, json.dumps({"url": direct or None, "proxy": play}),
                content_type="application/json; charset=utf-8",
            )

        # ---- Proxy video bytes (Range support for seeking) ----
        if parsed_path.path == "/api/proxy_video":
            target = params.get("url", [""])[0]
            host = urllib.parse.urlparse(target).hostname or ""
            if not target.startswith("http") or not VIDEO_HOST_RE.search(host):
                return self._respond(400, b"Missing url")
            return self._proxy_video(target)

        return super().do_GET()

    def _proxy_video(self, target):
        try:
            extra = {"Referer": "https://streamtape.com/", "Accept": "*/*"}
            range_hdr = self.headers.get("Range")
            if range_hdr:
                extra["Range"] = range_hdr

            with http_get(target, 30, extra) as resp:
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "video/mp4"))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
                self.send_header("Accept-Ranges", resp.headers.get("Accept-Ranges", "bytes"))
                for header in ("Content-Length", "Content-Range"):
                    value = resp.headers.get(header)
                    if value:
                        self.send_header(header, value)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()

                try:
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                except CLIENT_GONE:
                    # A lejátszó lezárta a kapcsolatot (tekerés, bezárás) – nem hiba
                    pass
        except Exception as e:
            print(f"proxy_video error: {e}")
            self._respond(502, str(e))

    def _resolve_streamtape(self, raw_url):
        """Extract playable get_video URL — evaluates Streamtape's substring obfuscation."""
        try:
            m_id = re.search(r"/(?:v|e|r)/([A-Za-z0-9]+)", raw_url)
            if not m_id:
                return None

            page_url = f"https://streamtape.com/e/{m_id.group(1)}"
            with http_get(page_url, 12, {
                "Referer": "https://streamtape.com/",
                "Accept-Language": "en-US,en;q=0.9",
            }) as resp:
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
                    payload = payload[int(sm.group(1)):]
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
