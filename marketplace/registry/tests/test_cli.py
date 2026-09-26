from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from registry import cli
from registry.package import read_package
from registry.signing import Ed25519SignatureVerifier
from tests.conftest import SignedEnv
from tests.fixtures import contract_manifest, valid_manifest, windows_backend_bytes


def _make_src(tmp_path: Path) -> Path:
    src = tmp_path / "plugin-src"
    src.mkdir()
    (src / "manifest.json").write_text(json.dumps(valid_manifest()))
    (src / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\n-icon")
    (src / "README.md").write_text("# Hello\n")
    (src / "artifact-files.json").write_text(
        json.dumps({"files": ["manifest.json", "icon.png", "README.md"]})
    )
    return src


def test_cli_help_exits_zero() -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0


def test_keygen_writes_usable_keypair(tmp_path: Path) -> None:
    assert cli.main(["keygen", "--out-dir", str(tmp_path), "--name", "acme"]) == 0
    priv = (tmp_path / "acme.key").read_text()
    assert stat.S_IMODE((tmp_path / "acme.key").stat().st_mode) == 0o600
    pub = (tmp_path / "acme.pub").read_text()
    from registry.signing import sign_digest

    digest = "c" * 64
    sig = sign_digest(priv, digest)
    assert Ed25519SignatureVerifier().verify(
        digest=digest, signature=sig, public_key=pub
    )


def test_keygen_refuses_to_overwrite_existing_private_key(tmp_path: Path) -> None:
    existing = tmp_path / "acme.key"
    existing.write_text("old")
    existing.chmod(0o644)
    with pytest.raises(FileExistsError):
        cli.main(["keygen", "--out-dir", str(tmp_path), "--name", "acme"])
    assert existing.read_text() == "old"
    assert stat.S_IMODE(existing.stat().st_mode) == 0o644


def test_pack_builds_valid_package(tmp_path: Path) -> None:
    src = _make_src(tmp_path)
    out = tmp_path / "out.vsix"
    assert cli.main(["pack", str(src), "--out", str(out)]) == 0
    loaded = read_package(out.read_bytes())
    assert loaded.manifest.id == "acme.hello"


def test_pack_requires_one_explicit_canonical_file_list(tmp_path: Path) -> None:
    src = _make_src(tmp_path)
    (src / "artifact-files.json").write_text('{"files":["manifest.json"],"files":[]}')
    assert cli.main(["pack", str(src)]) == 1


def test_pack_validates_a_windows_backend_for_its_target(tmp_path: Path) -> None:
    src = tmp_path / "plugin-src"
    (src / "backend").mkdir(parents=True)
    manifest = contract_manifest("backend-only-skills.json")
    (src / "manifest.json").write_text(json.dumps(manifest))
    (src / "backend" / "navide-skills.exe").write_bytes(windows_backend_bytes("x64"))
    (src / "artifact-files.json").write_text(json.dumps({"files": ["manifest.json", "backend/navide-skills.exe"]}))
    out = tmp_path / "out.vsix"
    # Without the target the bare entry is required, as before.
    assert cli.main(["pack", str(src), "--out", str(out)]) == 1
    assert cli.main(["pack", str(src), "--out", str(out), "--target", "win32-x64"]) == 0
    assert read_package(out.read_bytes(), target="win32-x64").manifest.id == manifest["id"]


def test_pack_sign_publish_roundtrip(
    tmp_path: Path, signed_env: SignedEnv
) -> None:
    src = _make_src(tmp_path)
    pkg = tmp_path / "acme.hello-1.0.0.vsix"
    key = tmp_path / "acme.key"
    sig = tmp_path / "acme.sig"
    key.write_text(signed_env.private_pem)
    key.chmod(0o600)

    # pack -> sign via the CLI commands.
    assert cli.main(["pack", str(src), "--out", str(pkg)]) == 0
    assert cli.main(["sign", str(pkg), "--key", str(key), "--out", str(sig)]) == 0

    # publish via the CLI transport, driven against the TestClient.
    status, _ = cli.post_package(
        "http://testserver",
        pkg,
        signed_env.token,
        sig.read_text().strip(),
        client=signed_env.client,
    )
    assert status == 201

    detail = signed_env.client.get("/api/extensions/acme/hello").json()
    assert detail["versions"][0]["trust_tier"] == "signed-verified"


def test_publish_carries_the_registry_target(
    tmp_path: Path, signed_env: SignedEnv
) -> None:
    src = tmp_path / "plugin-src"
    (src / "backend").mkdir(parents=True)
    manifest = contract_manifest("backend-only-skills.json")
    manifest.update({"id": "acme.hello", "publisher": "acme"})
    (src / "manifest.json").write_text(json.dumps(manifest))
    mach_header = (0xFEEDFACF).to_bytes(4, "little") + (0x0100000C).to_bytes(4, "little")
    (src / "backend" / "navide-skills").write_bytes(mach_header)
    (src / "artifact-files.json").write_text(json.dumps({"files": ["manifest.json", "backend/navide-skills"]}))
    pkg = tmp_path / "acme.hello-1.0.0.vsix"
    assert cli.main(["pack", str(src), "--out", str(pkg), "--target", "darwin-arm64"]) == 0
    signature = signed_env.sign(cli._digest(pkg.read_bytes()))
    status, _ = cli.post_package(
        "http://testserver",
        pkg,
        signed_env.token,
        signature,
        target="darwin-arm64",
        client=signed_env.client,
    )
    assert status == 201
    detail = signed_env.client.get("/api/extensions/acme/hello").json()
    assert detail["versions"][0]["target"] == "darwin-arm64"
    assert detail["versions"][0]["registry_envelope"]["target"] == "darwin-arm64"


def test_publish_requires_a_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.delenv(cli.TOKEN_ENV, raising=False)
    pkg = tmp_path / "x.vsix"
    pkg.write_bytes(b"")
    assert cli.main(["publish", str(pkg), "--registry", "http://127.0.0.1:9"]) == 2
    assert cli.TOKEN_ENV in capsys.readouterr().err
