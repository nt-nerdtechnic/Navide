from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import VERIFIER_ED25519, VERIFIER_ACCEPTING, Settings
from registry.signing import generate_keypair, sign_digest


@pytest.fixture()
def settings(tmp_path) -> Settings:
    # Dev/test posture: accepting verifier, no signature/auth requirement. The
    # security-specific tests build their own strict Settings.
    return Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
    )


@pytest.fixture()
def client(settings: Settings) -> TestClient:
    # No context manager: this app has no lifespan startup to run.
    return TestClient(create_app(settings))


@dataclass
class SignedEnv:
    """A strict (Ed25519 + auth-required) registry with a seeded publisher."""

    client: TestClient
    publisher: str
    token: str
    private_pem: str
    public_pem: str

    def sign(self, digest: str) -> str:
        return sign_digest(self.private_pem, digest)


@pytest.fixture()
def signed_env(tmp_path) -> SignedEnv:
    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ED25519,
        require_signature=True,
        require_auth=True,
    )
    client = TestClient(create_app(settings))
    private_pem, public_pem = generate_keypair()
    token = "tok-acme-secret"  # noqa: S105 - test fixture token
    resp = client.post(
        "/api/publishers",
        json={
            "name": "acme",
            "public_key": public_pem,
            "token": token,
            "display_name": "Acme",
        },
    )
    assert resp.status_code == 201, resp.text
    return SignedEnv(
        client=client,
        publisher="acme",
        token=token,
        private_pem=private_pem,
        public_pem=public_pem,
    )
