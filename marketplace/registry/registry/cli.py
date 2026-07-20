"""`navide-plugin` -- packaging + signing + publishing CLI (vsce-like).

Thin wrapper around the registry's own format builder (`package.build_package`)
and signing primitives (`signing`). Commands:

    navide-plugin keygen  [--out-dir DIR] [--name NAME]
    navide-plugin pack    <src_dir> [--out FILE]
    navide-plugin sign    <package> --key <privkey> [--out SIG]
    navide-plugin publish <package> --registry URL --token TOKEN [--signature SIG]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .package import PackageError, build_package
from .signing import generate_keypair, sign_digest


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cmd_keygen(args: argparse.Namespace) -> int:
    private_pem, public_pem = generate_keypair()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    priv_path = out_dir / f"{args.name}.key"
    pub_path = out_dir / f"{args.name}.pub"
    priv_path.write_text(private_pem)
    pub_path.write_text(public_pem)
    print(f"private key: {priv_path}")
    print(f"public key:  {pub_path}")
    return 0


def cmd_pack(args: argparse.Namespace) -> int:
    src = Path(args.src_dir)
    try:
        data = build_package(src)
    except PackageError as exc:
        print(f"pack failed: {exc}", file=sys.stderr)
        return 1
    manifest = json.loads((src / "manifest.json").read_text())
    default_out = f"{manifest['id']}-{manifest['version']}.vsix"
    out_path = Path(args.out) if args.out else Path(default_out)
    out_path.write_bytes(data)
    print(f"packed {out_path} ({len(data)} bytes, sha256 {_digest(data)})")
    return 0


def cmd_sign(args: argparse.Namespace) -> int:
    package_path = Path(args.package)
    private_pem = Path(args.key).read_text()
    signature = sign_digest(private_pem, _digest(package_path.read_bytes()))
    if args.out:
        Path(args.out).write_text(signature)
        print(f"signature written to {args.out}")
    else:
        print(signature)
    return 0


def post_package(
    registry_url: str,
    package_path: Path | str,
    token: str,
    signature: str | None = None,
    *,
    client: object | None = None,
) -> tuple[int, str]:
    """Upload a package to `<registry_url>/api/publish`.

    `client` (duck-typed like a FastAPI TestClient / httpx.Client with `.post`)
    lets tests drive the exact request without a live server; when omitted a
    stdlib multipart POST is used.
    """
    package_path = Path(package_path)
    data = package_path.read_bytes()
    url = registry_url.rstrip("/") + "/api/publish"
    params = {"signature": signature} if signature else None
    headers = {"Authorization": f"Bearer {token}"}

    if client is not None:
        resp = client.post(
            url,
            files={"package": (package_path.name, data, "application/zip")},
            params=params,
            headers=headers,
        )
        return resp.status_code, resp.text

    if signature:
        url += f"?signature={urllib.parse.quote(signature)}"
    body, content_type = _multipart(package_path.name, data)
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req) as resp:  # noqa: S310 - operator-supplied URL
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # pragma: no cover - network path
        return exc.code, exc.read().decode("utf-8", "replace")


def _multipart(filename: str, data: bytes) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    pre = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="package"; filename="{filename}"\r\n'
        "Content-Type: application/zip\r\n\r\n"
    ).encode("utf-8")
    post = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return pre + data + post, f"multipart/form-data; boundary={boundary}"


def cmd_publish(args: argparse.Namespace) -> int:
    signature = None
    if args.signature:
        sig_path = Path(args.signature)
        signature = (
            sig_path.read_text().strip() if sig_path.is_file() else args.signature
        )
    status, text = post_package(
        args.registry, args.package, args.token, signature
    )
    print(f"{status} {text}")
    return 0 if 200 <= status < 300 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="navide-plugin")
    sub = parser.add_subparsers(dest="command", required=True)

    p_keygen = sub.add_parser("keygen", help="generate an Ed25519 keypair")
    p_keygen.add_argument("--out-dir", default=".")
    p_keygen.add_argument("--name", default="publisher")
    p_keygen.set_defaults(func=cmd_keygen)

    p_pack = sub.add_parser("pack", help="build a .vsix package from a source dir")
    p_pack.add_argument("src_dir")
    p_pack.add_argument("--out")
    p_pack.set_defaults(func=cmd_pack)

    p_sign = sub.add_parser("sign", help="detached-sign a package")
    p_sign.add_argument("package")
    p_sign.add_argument("--key", required=True, help="private key PEM path")
    p_sign.add_argument("--out")
    p_sign.set_defaults(func=cmd_sign)

    p_pub = sub.add_parser("publish", help="upload a package to a registry")
    p_pub.add_argument("package")
    p_pub.add_argument("--registry", required=True)
    p_pub.add_argument("--token", required=True)
    p_pub.add_argument("--signature", help="signature string or a file path")
    p_pub.set_defaults(func=cmd_publish)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
