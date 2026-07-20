"""Publisher-identity seam.

Real publisher authentication (OAuth / tokens) is the `p3-publish` todo. This
slice exposes the identity as a thin injectable dependency so endpoints can
depend on it now; the stub reads an optional `X-Publisher` header and otherwise
falls back to a dev identity.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header

DEV_PUBLISHER = "dev"


@dataclass(frozen=True)
class PublisherIdentity:
    publisher: str


def get_publisher_identity(
    x_publisher: str | None = Header(default=None),
) -> PublisherIdentity:
    """Resolve the calling publisher.

    TODO(p3-publish): replace with real token/OAuth authentication and verify
    the caller is entitled to publish under the manifest's publisher/namespace.
    """
    return PublisherIdentity(publisher=x_publisher or DEV_PUBLISHER)
