"""Test-only server: serves ../ui and answers the same commands the Rust side does,
using Python's sqlite3 (same SQLite engine). Not shipped with the app."""
import json, sqlite3, sys, os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = sqlite3.connect(":memory:", check_same_thread=False)
DB.executescript(open(os.path.join(ROOT, "src-tauri/src/schema.sql")).read())
CALLS = []

MOCK_JS = b"""<script>
window.__mockInvoke = async (cmd, args) => {
  const r = await fetch('/invoke', {method:'POST', body: JSON.stringify({cmd, args})});
  const j = await r.json();
  if (j.error) throw j.error;
  return j.result;
};
window.print = () => { window.__printed = document.getElementById('print-area').innerHTML; window.dispatchEvent(new Event('afterprint')); };
</script>"""


def handle(cmd, a):
    CALLS.append({"cmd": cmd, "args": a})
    if cmd == "db_query":
        cur = DB.execute(a["sql"], a["params"])
        cols = [d[0] for d in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    if cmd == "db_execute":
        cur = DB.execute(a["sql"], a["params"])
        DB.commit()
        return {"changes": cur.rowcount, "lastId": cur.lastrowid}
    if cmd == "app_info":
        return {"dataDir": "C:\\Apps\\Punchlist\\PunchlistData", "dbPath": "x", "version": "1.0.0"}
    if cmd == "backup_db":
        return "C:\\Apps\\Punchlist\\PunchlistData\\backups\\" + a["fileName"]
    if cmd == "export_xlsx":
        return "C:\\Users\\me\\Documents\\" + a["defaultName"]
    if cmd in ("open_url", "open_data_folder"):
        return None
    raise ValueError("unknown command " + cmd)


class H(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kw):
        super().__init__(*args, directory=os.path.join(ROOT, "ui"), **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/calls":
            body = json.dumps(CALLS).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
            return
        if self.path in ("/", "/index.html"):
            html = open(os.path.join(ROOT, "ui/index.html"), "rb").read()
            html = html.replace(b'<script src="app.js">', MOCK_JS + b'<script src="app.js">')
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(html)
            return
        super().do_GET()

    def do_POST(self):
        n = int(self.headers["Content-Length"])
        req = json.loads(self.rfile.read(n))
        try:
            out = {"result": handle(req["cmd"], req.get("args", {}))}
        except Exception as e:
            out = {"error": str(e)}
        body = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print("sqlite", sqlite3.sqlite_version, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
