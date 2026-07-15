import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from agent_team_backend.claude_hooks import _build_curl_command


def test_stop_hook_forwards_payload_without_response_body(tmp_path) -> None:
    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            received.append(self.rfile.read(length))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 5
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file = tmp_path / "backend.port"
    port_file.write_text(str(server.server_port), encoding="utf-8")
    payload = '{"hook_event_name":"Stop","session_id":"session-1"}'

    try:
        result = subprocess.run(
            _build_curl_command(str(port_file), "stop"),
            shell=True,
            input=payload,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    finally:
        thread.join(timeout=6)
        server.server_close()

    assert received == [payload.encode()]
    assert result.stdout == ""
