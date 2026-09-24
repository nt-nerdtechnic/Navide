from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from registry import cli
from registry.package import read_package
from registry.signing import Ed25519SignatureVerifier, read_private_key_file
from tests.conftest import SignedEnv
from tests.fixtures import valid_manifest


def _make_src(tmp_path: Path) -> Path:
    src = tmp_path / "plugin-src"
    src.mkdir()
    (src / "manifest.json").write_text(json.dumps(valid_manifest()))
    (src / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\n-icon")
    (src / "README.md").write_text("# Hello\n")
    return src


def test_cli_help_exits_zero() -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0


def test_keygen_writes_usable_keypair(tmp_path: Path) -> None:
    assert cli.main(["keygen", "--out-dir", str(tmp_path), "--name", "acme"]) == 0
    priv = (tmp_path / "acme.key").read_text()
    pub = (tmp_path / "acme.pub").read_text()
    from registry.signing import sign_digest

    digest = "c" * 64
    sig = sign_digest(priv, digest)
    assert Ed25519SignatureVerifier().verify(
        digest=digest, signature=sig, public_key=pub
    )


def test_keygen_writes_owner_only_private_key(tmp_path: Path) -> None:
    existing = tmp_path / "acme.key"
    existing.write_text("old")
    existing.chmod(0o644)
    assert cli.main(["keygen", "--out-dir", str(tmp_path), "--name", "acme"]) == 0
    assert stat.S_IMODE(existing.stat().st_mode) == 0o600
    # The registry's own strict reader accepts it.
    assert read_private_key_file(existing).startswith("-----BEGIN PRIVATE KEY-----")


def test_pack_builds_valid_package(tmp_path: Path) -> None:
    src = _make_src(tmp_path)
    out = tmp_path / "out.vsix"
    assert cli.main(["pack", str(src), "--out", str(out)]) == 0
    loaded = read_package(out.read_bytes())
    assert loaded.manifest.id == "acme.hello"


def test_pack_sign_publish_roundtrip(
    tmp_path: Path, signed_env: SignedEnv
) -> None:
    src = _make_src(tmp_path)
    pkg = tmp_path / "acme.hello-1.0.0.vsix"
    key = tmp_path / "acme.key"
    sig = tmp_path / "acme.sig"
    key.write_text(signed_env.private_pem)

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
    src = _make_src(tmp_path)
    pkg = tmp_path / "acme.hello-1.0.0.vsix"
    assert cli.main(["pack", str(src), "--out", str(pkg)]) == 0
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
