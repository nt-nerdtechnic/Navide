"""fs_service.convert_office — docx→html (mammoth), xlsx→rows (openpyxl), caps."""

from __future__ import annotations

import zipfile
from pathlib import Path

import openpyxl

from agent_team_backend import fs_service

_DOCX_CONTENT_TYPES = """<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

_DOCX_RELS = """<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOCX_DOCUMENT = """<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Hello docx</w:t></w:r></w:p></w:body>
</w:document>"""


def _ws(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def _write_docx(path: Path) -> None:
    """Minimal hand-built OOXML package that mammoth accepts."""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES)
        zf.writestr("_rels/.rels", _DOCX_RELS)
        zf.writestr("word/document.xml", _DOCX_DOCUMENT)


def _write_xlsx(path: Path, sheets: dict[str, list[list]]) -> None:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        sheet = wb.create_sheet(title=name)
        for row in rows:
            sheet.append(row)
    wb.save(path)


# ── docx ────────────────────────────────────────────────────────────────────
def test_docx_converts_to_html(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_docx(ws / "doc.docx")
    res = fs_service.convert_office(str(ws), "doc.docx")
    assert res["ok"] is True
    assert res["kind"] == "docx"
    assert res["html"] == "<p>Hello docx</p>"


def test_corrupted_docx_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws / "bad.docx").write_bytes(b"not an ooxml package")
    res = fs_service.convert_office(str(ws), "bad.docx")
    assert res["ok"] is False
    assert "cannot convert docx" in res["error"]


# ── xlsx ────────────────────────────────────────────────────────────────────
def test_xlsx_converts_to_sheets(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_xlsx(ws / "book.xlsx", {
        "Data": [["name", "count"], ["alpha", 3], ["beta", None]],
        "Empty": [],
    })
    res = fs_service.convert_office(str(ws), "book.xlsx")
    assert res["ok"] is True
    assert res["kind"] == "xlsx"
    assert [s["name"] for s in res["sheets"]] == ["Data", "Empty"]
    data = res["sheets"][0]
    # Cells stringified; None becomes "".
    assert data["rows"] == [["name", "count"], ["alpha", "3"], ["beta", ""]]
    assert data["truncated"] is False
    assert res["sheets"][1]["rows"] == []


def test_xlsx_row_cap_truncates_at_1000(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_xlsx(ws / "tall.xlsx", {"S": [[f"r{i}"] for i in range(1005)]})
    res = fs_service.convert_office(str(ws), "tall.xlsx")
    assert res["ok"] is True
    sheet = res["sheets"][0]
    assert len(sheet["rows"]) == 1000
    assert sheet["truncated"] is True


def test_xlsx_col_cap_truncates_at_100(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_xlsx(ws / "wide.xlsx", {"S": [[f"c{i}" for i in range(105)]]})
    res = fs_service.convert_office(str(ws), "wide.xlsx")
    assert res["ok"] is True
    sheet = res["sheets"][0]
    assert len(sheet["rows"][0]) == 100
    assert sheet["rows"][0][99] == "c99"
    assert sheet["truncated"] is True


def test_corrupted_xlsx_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws / "bad.xlsx").write_bytes(b"not an ooxml package")
    res = fs_service.convert_office(str(ws), "bad.xlsx")
    assert res["ok"] is False
    assert "cannot read xlsx" in res["error"]


# ── Shared guards ───────────────────────────────────────────────────────────
def test_size_cap_rejects_over_10mb(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_docx(ws / "huge.docx")
    # Sparse-grow past the cap: st_size is what the guard checks.
    with (ws / "huge.docx").open("r+b") as fh:
        fh.truncate(10 * 1024 * 1024 + 1)
    res = fs_service.convert_office(str(ws), "huge.docx")
    assert res["ok"] is False
    assert "too large" in res["error"]


def test_unsupported_extension_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws / "notes.txt").write_text("plain")
    res = fs_service.convert_office(str(ws), "notes.txt")
    assert res["ok"] is False
    assert "unsupported office file type" in res["error"]


def test_missing_file_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.convert_office(str(ws), "nope.docx")
    assert res["ok"] is False


def test_path_escape_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_docx(tmp_path / "outside.docx")
    res = fs_service.convert_office(str(ws), "../outside.docx")
    assert res["ok"] is False
    assert "escape" in res["error"].lower()
