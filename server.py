import http.client
import http.server
import socketserver
import urllib.request
import urllib.parse
import re
import json
import os
import ssl
import threading
import time
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

DRIVE_ID_RE = re.compile(r"[A-Za-z0-9_-]{10,200}")
# Streamtape videóazonosító: a linkből (/v/, /e/, /r/ után) és a /api/stream?id= paraméterben
STREAMTAPE_ID_RE = re.compile(r"/(?:v|e|r)/([A-Za-z0-9]+)")
STREAM_ID_RE = re.compile(r"[A-Za-z0-9]{1,64}")
CONTENT_RANGE_RE = re.compile(r"bytes\s+(\d+)-(\d+)/")
# Ha a Streamtape menet közben elakad, ennyiszer próbáljuk egymás után folytatni
UPSTREAM_RETRIES = 3
STREAM_CHUNK = 64 * 1024

# Feloldott közvetlen linkek (azonosító → get_video link). A token idővel lejár,
# ilyenkor a /api/stream magától újat old fel.
LINK_CACHE_LIMIT = 200
_links = {}
_links_lock = threading.Lock()
# A /api/read_text?raw=1 legfeljebb ekkora fájlt ad vissza (feliratokhoz bőven elég)
RAW_LIMIT = 5 * 1024 * 1024

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

    def _drive_text(self, file_id, meta_timeout=2.5, download_timeout=3, use_description=True):
        """Drive szövegfájl tartalma: előbb a description metaadat, aztán a letöltés.
        use_description=False: a description csonka volt (nagyon hosszú episodes.json), a fájl kell."""
        if use_description:
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

    def _drive_raw(self, file_id):
        """Drive fájl bájtjai változatlanul (felirat: a kódolást a böngésző ismeri fel).
        Méretkorláttal, hogy a szerver ne legyen általános Drive-letöltő proxy."""
        urls = (
            f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&key={API_KEY}",
            f"https://drive.google.com/uc?export=download&id={file_id}",
        )
        for url in urls:
            try:
                with http_get(url, 8) as resp:
                    content_type = (resp.headers.get("Content-Type") or "").lower()
                    data = resp.read(RAW_LIMIT + 1)
            except Exception as e:
                print(f"Drive raw read for {file_id}: {e}")
                continue
            if len(data) > RAW_LIMIT:
                return self._respond(413, b"File too large")
            # Bejelentkező vagy vírusellenőrzés-figyelmeztető oldal — nem a fájl
            if "text/html" in content_type:
                continue
            return self._respond(
                200, data,
                content_type="application/octet-stream",
                extra_headers={"Cache-Control": "no-store"},
            )
        return self._respond(404, b"Not found")

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed_path.query)

        # ---- Szövegfájl (magnet, leírás, kategória…) a Drive-ról ----
        if parsed_path.path == "/api/read_text":
            file_id = params.get("id", [None])[0]
            torrent_title = params.get("title", [""])[0]
            if not file_id:
                return self._respond(400, b"Missing file id")
            # A Drive azonosító csak betű, szám, - és _ lehet — más nem kerülhet a lekért URL-be
            if not DRIVE_ID_RE.fullmatch(file_id):
                return self._respond(400, b"Bad file id")

            # raw=1: a fájl bájtjai változatlanul (felirat)
            if params.get("raw", [""])[0] == "1":
                return self._drive_raw(file_id)

            try:
                text_content = self._drive_text(file_id, use_description=params.get("nodesc", [""])[0] != "1")
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

            m_id = STREAMTAPE_ID_RE.search(raw_url)
            vid = m_id.group(1) if m_id else None
            direct = self._stream_link(vid) if vid else None
            # A lejátszó azonosítóval, a szerveren át kéri a videót: a token-link lejárhat,
            # a /api/stream ilyenkor magától újat old fel
            play = f"/api/stream?id={vid}" if direct else None
            return self._respond(
                200, json.dumps({"url": direct or None, "proxy": play}),
                content_type="application/json; charset=utf-8",
            )

        # ---- Videó bájtjai azonosító alapján (Range, lejárt link és megszakadás kezelése) ----
        if parsed_path.path == "/api/stream":
            vid = params.get("id", [""])[0]
            if not STREAM_ID_RE.fullmatch(vid):
                return self._respond(400, b"Bad id")
            return self._stream_video(vid)

        # ---- Proxy video bytes (Range support for seeking) ----
        # Régi, közvetlen linkes út: a frissítés előtt megnyitott oldalak még ezt kérik
        if parsed_path.path == "/api/proxy_video":
            target = params.get("url", [""])[0]
            host = urllib.parse.urlparse(target).hostname or ""
            if not target.startswith("http") or not VIDEO_HOST_RE.search(host):
                return self._respond(400, b"Missing url")
            return self._proxy_video(target)

        return super().do_GET()

    @staticmethod
    def _video_request_headers(range_hdr):
        extra = {"Referer": "https://streamtape.com/", "Accept": "*/*"}
        if range_hdr:
            extra["Range"] = range_hdr
        return extra

    def _send_video_headers(self, resp):
        """A Streamtape válaszának fejlécei a lejátszónak (Range: seekeléshez kell)."""
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

    def _proxy_video(self, target):
        try:
            extra = self._video_request_headers(self.headers.get("Range"))
            with http_get(target, 30, extra) as resp:
                self._send_video_headers(resp)

                try:
                    while True:
                        chunk = resp.read(STREAM_CHUNK)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                except CLIENT_GONE:
                    # A lejátszó lezárta a kapcsolatot (tekerés, bezárás) – nem hiba
                    pass
        except Exception as e:
            print(f"proxy_video error: {e}")
            self._respond(502, str(e))

    def _stream_link(self, vid, fresh=False):
        """A videó közvetlen linkje: a megjegyzett, vagy (fresh / még nincs) frissen feloldott."""
        if not fresh:
            with _links_lock:
                direct = _links.get(vid)
            if direct:
                return direct

        direct = self._resolve_streamtape(f"https://streamtape.com/e/{vid}")
        if direct:
            with _links_lock:
                _links.pop(vid, None)
                _links[vid] = direct
                while len(_links) > LINK_CACHE_LIMIT:
                    _links.pop(next(iter(_links)))
        return direct

    def _open_upstream(self, vid, range_hdr):
        """Megnyitja a videót a Streamtape-en. Ha a megjegyzett link már nem jó (lejárt token:
        hibakód vagy HTML oldal jön videó helyett), friss linket old fel és újrapróbálja."""
        extra = self._video_request_headers(range_hdr)
        error = None
        for fresh in (False, True):
            direct = self._stream_link(vid, fresh)
            if not direct:
                error = error or ValueError("nincs közvetlen link")
                continue
            try:
                resp = http_get(direct, 30, extra)
            except (OSError, http.client.HTTPException) as e:
                error = e
                continue
            if "text/html" in (resp.headers.get("Content-Type") or "").lower():
                resp.close()
                error = ValueError("HTML oldal jött videó helyett")
                continue
            return resp
        raise error

    def _stream_video(self, vid):
        """A videó bájtjai a Streamtape-ről. Ha a Streamtape menet közben elakad vagy bontja
        a kapcsolatot (pl. amíg a lejátszó a pufferből játszik és nem kér adatot), onnan
        folytatja, ahol abbamaradt — ugyanabba a válaszba, a lejátszó ebből semmit nem vesz észre."""
        try:
            resp = self._open_upstream(vid, self.headers.get("Range"))
        except Exception as e:
            print(f"stream {vid}: {e}")
            return self._respond(502, str(e))

        # Honnan és hány bájtot kell összesen elküldeni (folytatáshoz kell)
        m_range = CONTENT_RANGE_RE.match(resp.headers.get("Content-Range") or "")
        start = int(m_range.group(1)) if m_range else 0
        length_hdr = resp.headers.get("Content-Length") or ""
        length = int(length_hdr) if length_hdr.isdigit() else None

        def reopen(pos):
            """Újranyitás a pos. bájttól; None, ha nem sikerült vagy nem onnan jön az adat."""
            try:
                r = self._open_upstream(vid, f"bytes={pos}-{start + length - 1}")
            except Exception as e:
                print(f"stream {vid}: újranyitás sikertelen: {e}")
                return None
            m = CONTENT_RANGE_RE.match(r.headers.get("Content-Range") or "")
            if r.status != 206 or not m or int(m.group(1)) != pos:
                r.close()
                print(f"stream {vid}: újranyitáskor nem a kért részt kaptuk ({r.status})")
                return None
            return r

        sent = 0
        retries = 0
        try:
            try:
                self._send_video_headers(resp)
            except CLIENT_GONE:
                return

            while length is None or sent < length:
                chunk = b""
                if resp:
                    try:
                        chunk = resp.read(STREAM_CHUNK if length is None else min(STREAM_CHUNK, length - sent))
                    except (OSError, http.client.HTTPException) as e:
                        print(f"stream {vid}: olvasási hiba: {e}")
                if chunk:
                    try:
                        self.wfile.write(chunk)
                    except CLIENT_GONE:
                        # A lejátszó lezárta a kapcsolatot (tekerés, bezárás) – nem hiba
                        return
                    sent += len(chunk)
                    retries = 0
                    continue

                # Elfogyott az adat, pedig még nem ment ki minden bájt: a Streamtape szakította meg
                if length is None or retries >= UPSTREAM_RETRIES:
                    break
                retries += 1
                if resp:
                    resp.close()
                pos = start + sent
                print(f"stream {vid}: megszakadt @{pos}, folytatás ({retries}/{UPSTREAM_RETRIES})")
                time.sleep(retries)
                resp = reopen(pos)
        finally:
            if resp:
                resp.close()

        if length is not None and sent < length:
            print(f"stream {vid}: feladva @{start + sent}, {length - sent} bájt hiányzik")

    def _resolve_streamtape(self, raw_url):
        """Extract playable get_video URL — evaluates Streamtape's substring obfuscation."""
        try:
            m_id = STREAMTAPE_ID_RE.search(raw_url)
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
