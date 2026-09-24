"""Generic local fakes for chat-platform adapters: a scripted HTTP API and a websocket server.

Both bind 127.0.0.1 on an ephemeral port. ``FakeHttp`` runs in a thread (so a
long-poll can block without stalling the test's event loop); ``FakeWs`` runs
in the test's own event loop.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve


@dataclass
class Req:
    method: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: Any = None
    raw: bytes = b""

    def form(self) -> dict[str, str]:
        return {k: v[0] for k, v in parse_qs(self.raw.decode()).items()}


@dataclass
class Resp:
    status: int = 200
    body: Any = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


Handler = Callable[[Req], "Resp | dict[str, Any] | list[Any]"]


class FakeHttp:
    def __init__(self) -> None:
        self.calls: list[Req] = []
        self._routes: list[tuple[str, re.Pattern[str], Handler]] = []
        self._errors: list[tuple[str, re.Pattern[str], Resp]] = []
        self.lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler_cls())
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeHttp":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    def route(self, method: str, path_re: str, handler: Handler) -> None:
        self._routes.append((method, re.compile(path_re), handler))

    def fail(self, method: str, path_re: str, status: int, body: Any = None,
             headers: dict[str, str] | None = None, times: int = 1) -> None:
        with self.lock:
            for _ in range(times):
                self._errors.append((method, re.compile(path_re), Resp(status, body or {}, headers or {})))

    def calls_to(self, method: str, path_re: str) -> list[Req]:
        pat = re.compile(path_re)
        with self.lock:
            return [c for c in self.calls if c.method == method and pat.fullmatch(c.path)]

    def _dispatch(self, req: Req) -> Resp:
        with self.lock:
            self.calls.append(req)
            for i, (m, pat, resp) in enumerate(self._errors):
                if m == req.method and pat.fullmatch(req.path):
                    del self._errors[i]
                    return resp
        for m, pat, handler in self._routes:
            if m == req.method and pat.fullmatch(req.path):
                out = handler(req)
                return out if isinstance(out, Resp) else Resp(200, out)
        return Resp(404, {"message": f"no route {req.method} {req.path}"})

    def _handler_cls(self) -> type[BaseHTTPRequestHandler]:
        api = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                body: Any = None
                if raw and "json" in (self.headers.get("Content-Type") or ""):
                    body = json.loads(raw)
                parts = urlsplit(self.path)
                req = Req(self.command, parts.path, {k: v[0] for k, v in parse_qs(parts.query).items()},
                          {k.lower(): v for k, v in self.headers.items()}, body, raw)
                resp = api._dispatch(req)
                data = resp.body if isinstance(resp.body, (bytes, str)) else json.dumps(resp.body)
                data_b = data.encode() if isinstance(data, str) else data
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                for k, v in resp.headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data_b)))
                self.end_headers()
                self.wfile.write(data_b)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _serve  # noqa: N815

        return H


WsHandler = Callable[[ServerConnection], Awaitable[None]]


class FakeWs:
    """Websocket server; ``handler`` is swapped per test and per connection."""

    def __init__(self, handler: WsHandler, process_request: Any = None) -> None:
        self.handler = handler
        self.process_request = process_request
        self.connections: list[ServerConnection] = []
        self._server: Any = None

    async def __aenter__(self) -> "FakeWs":
        self._server = await serve(self._serve, "127.0.0.1", 0, process_request=self.process_request)
        return self

    async def __aexit__(self, *exc: object) -> None:
        self._server.close()
        await self._server.wait_closed()

    @property
    def url(self) -> str:
        host, port = list(self._server.sockets)[0].getsockname()[:2]
        return f"ws://{host}:{port}"

    async def _serve(self, ws: ServerConnection) -> None:
        self.connections.append(ws)
        await self.handler(ws)
