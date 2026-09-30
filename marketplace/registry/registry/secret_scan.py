"""Secret scan of package contents (Phase 2 review check).

A finding records the archive path, the 1-based line and the rule name —
never the matched text. The report is shown to the publisher and the
reviewer, so echoing the value would leak it a second time.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from io import BytesIO

MAX_SCANNED_BYTES_PER_FILE = 5 * 1024 * 1024
MAX_FINDINGS = 50

RULES: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    ("AWS access key id", re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    (
        "AWS secret access key",
        re.compile(rb"(?i)aws_?secret_?access_?key[\"'\s:=]+[A-Za-z0-9/+]{40}\b"),
    ),
    ("GitHub token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("Slack token", re.compile(rb"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Stripe live key", re.compile(rb"\b[rs]k_live_[0-9A-Za-z]{24,}\b")),
    ("Anthropic API key", re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAI API key", re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b|\bsk-proj-[A-Za-z0-9_-]{40,}")),
    ("npm token", re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b")),
    (
        "private key block",
        re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----"),
    ),
)


@dataclass(frozen=True)
class SecretFinding:
    path: str
    line: int
    rule: str

    def as_dict(self) -> dict[str, object]:
        return {"path": self.path, "line": self.line, "rule": self.rule}


@dataclass(frozen=True)
class ScanReport:
    files_scanned: int
    findings: tuple[SecretFinding, ...]
    truncated: bool

    def as_dict(self) -> dict[str, object]:
        return {
            "files_scanned": self.files_scanned,
            "findings": [f.as_dict() for f in self.findings],
            "truncated": self.truncated,
        }


def _is_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192]


def scan_bytes(path: str, data: bytes) -> list[SecretFinding]:
    findings: list[SecretFinding] = []
    for rule, pattern in RULES:
        for match in pattern.finditer(data):
            line = data.count(b"\n", 0, match.start()) + 1
            findings.append(SecretFinding(path=path, line=line, rule=rule))
    return findings


def scan_package(data: bytes) -> ScanReport:
    """Scan every non-binary member of a validated package archive."""
    findings: list[SecretFinding] = []
    scanned = 0
    truncated = False
    with zipfile.ZipFile(BytesIO(data)) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            with archive.open(info) as stream:
                content = stream.read(MAX_SCANNED_BYTES_PER_FILE + 1)
            if len(content) > MAX_SCANNED_BYTES_PER_FILE:
                truncated = True
                content = content[:MAX_SCANNED_BYTES_PER_FILE]
            if _is_binary(content):
                continue
            scanned += 1
            findings.extend(scan_bytes(info.filename, content))
    findings.sort(key=lambda f: (f.path, f.line, f.rule))
    if len(findings) > MAX_FINDINGS:
        findings = findings[:MAX_FINDINGS]
        truncated = True
    return ScanReport(files_scanned=scanned, findings=tuple(findings), truncated=truncated)
