"""Publisher identity via bearer tokens (p3-publish).

A publisher authenticates with `Authorization: Bearer <token>`; the token is
matched (by sha256) against `Publisher.token_hash`. In dev (`require_auth`
False) an anonymous caller is allowed and the publisher is taken from the
manifest, preserving the pre-auth behavior. Namespace entitlement (a publisher
may only publish under its own namespace) is enforced by the endpoints using
the resolved identity.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, Request
from sqlmodel import Session

from .repository import RegistryRepository

DEV_PUBLISHER = "dev"


@dataclass(frozen=True)
class PublisherIdentity:
    publisher: str | None
    authenticated: bool


def _parse_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def get_publisher_identity(
    request: Request,
    authorization: str | None = Header(default=None),
    x_publisher: str | None = Header(default=None),
) -> PublisherIdentity:
    """Resolve the calling publisher from a bearer token, or dev fallback."""
    state = request.app.state.registry
    token = _parse_bearer(authorization)
    if token is not None:
        with Session(state.engine) as session:
            publisher = RegistryRepository(session).get_publisher_by_token(token)
        if publisher is None:
            raise HTTPException(status_code=401, detail="invalid publisher token")
        return PublisherIdentity(publisher=publisher.name, authenticated=True)

    if state.settings.require_auth:
        raise HTTPException(
            status_code=401, detail="missing publisher bearer token"
        )
    # Dev fallback: anonymous; publisher comes from the manifest downstream.
    return PublisherIdentity(publisher=x_publisher, authenticated=False)
