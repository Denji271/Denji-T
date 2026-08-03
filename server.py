import http.server
import socketserver
import urllib.request
import re
import json
import urllib.parse
import os
import ssl

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

class TorrentProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        
        # Handle API endpoint for reading Google Drive text files (magnet.txt, etc.)
        if parsed_path.path == '/api/read_text':
            query_params = urllib.parse.parse_qs(parsed_path.query)
            file_id = query_params.get('id', [None])[0]
            torrent_title = query_params.get('title', [''])[0]
            
            if not file_id:
                self.send_response(400)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'Missing file id')
                return
            
            try:
                uc_url = f'https://drive.google.com/uc?export=download&id={file_id}'
                req = urllib.request.Request(uc_url, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                })
                with urllib.request.urlopen(req, context=ssl_ctx, timeout=5) as response:
                    text_content = response.read().decode('utf-8', errors='ignore')
                
                # Check for full magnet URI match (including &dn= and &tr= parameters!)
                match = re.search(r'magnet:\?xt=urn:[^\s"\'<>]+', text_content, re.IGNORECASE)
                result_text = match.group(0) if match else text_content.strip()

                # If it's a magnet link and missing &dn= display name, append the title!
                if result_text.startswith('magnet:?') and '&dn=' not in result_text.lower() and torrent_title:
                    result_text += f"&dn={urllib.parse.quote(torrent_title)}"

                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(result_text.encode('utf-8'))
                return
            except Exception as e:
                print(f'Error fetching Drive text for {file_id}:', e)
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'')
                return
        
        return super().do_GET()

if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), TorrentProxyHandler) as httpd:
        print(f"Denji-T Server running at http://localhost:{PORT}")
        httpd.serve_forever()
