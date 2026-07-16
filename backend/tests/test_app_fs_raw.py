"""Tests for the GET /fs/raw HTTP endpoint (raw workspace file serving)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_team_backend.app import app


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    return TestClient(app)


@pytest.fixture()
def workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "video.mp4").write_bytes(bytes(range(256)) * 4)  # 1024 bytes
    (ws / "doc.pdf").write_bytes(b"%PDF-1.4 fake")
    (ws / "blob.zzz").write_bytes(b"\x00\x01\x02unknown")
    (ws / "page.html").write_text("<script>alert(1)</script>")
    (ws / "vector.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (ws / "sub").mkdir()
    (ws / ".agent-team").mkdir()
    (ws / ".agent-team" / "secret.txt").write_text("internal")
    (tmp_path / "outside.txt").write_text("outside")
    return ws


def _get(client, ws, rel, **kwargs):
    return client.get("/fs/raw", params={"workspace": str(ws), "rel": rel}, **kwargs)


def test_raw_happy_path_mp4(client, workspace):
    resp = _get(client, workspace, "video.mp4")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "video/mp4"
    assert resp.content == bytes(range(256)) * 4


def test_raw_content_type_pdf(client, workspace):
    resp = _get(client, workspace, "doc.pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"


def test_raw_unknown_extension_falls_back_to_octet_stream(client, workspace):
    resp = _get(client, workspace, "blob.zzz")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"


def test_raw_html_downgraded_to_attachment(client, workspace):
    # Non-media types must never render inline on the backend origin (XSS).
    resp = _get(client, workspace, "page.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.headers["content-security-policy"] == "sandbox"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_raw_svg_inline_but_sandboxed(client, workspace):
    # SVG stays viewable in <img> while CSP sandbox blocks direct-nav scripts.
    resp = _get(client, workspace, "vector.svg")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/svg+xml"
    assert resp.headers["content-security-policy"] == "sandbox"


def test_raw_pdf_has_no_csp_sandbox(client, workspace):
    # CSP sandbox would disable Chromium's embedded PDF viewer.
    resp = _get(client, workspace, "doc.pdf")
    assert "content-security-policy" not in resp.headers
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_raw_range_request_returns_206(client, workspace):
    resp = _get(client, workspace, "video.mp4", headers={"Range": "bytes=0-99"})
    assert resp.status_code == 206
    assert resp.content == (bytes(range(256)) * 4)[:100]
    assert len(resp.content) == 100
    assert resp.headers["content-range"] == "bytes 0-99/1024"


def test_raw_path_escape_rejected(client, workspace):
    resp = _get(client, workspace, "../outside.txt")
    assert resp.status_code == 400


def test_raw_agent_team_dir_protected(client, workspace):
    resp = _get(client, workspace, ".agent-team/secret.txt")
    assert resp.status_code == 400


def test_raw_missing_file_returns_404(client, workspace):
    resp = _get(client, workspace, "nope.bin")
    assert resp.status_code == 404


def test_raw_directory_returns_400(client, workspace):
    resp = _get(client, workspace, "sub")
    assert resp.status_code == 400


def test_raw_nonexistent_workspace_rejected(client, tmp_path):
    # Same trust boundary as ws fs.* handlers: any existing directory is a
    # valid workspace; a non-existent one fails _resolve_safe with 400.
    resp = client.get(
        "/fs/raw",
        params={"workspace": str(tmp_path / "no-such-ws"), "rel": "a.txt"},
    )
    assert resp.status_code == 400
