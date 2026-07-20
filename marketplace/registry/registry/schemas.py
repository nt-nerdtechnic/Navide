"""API response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class VersionInfo(BaseModel):
    version: str
    package_digest: str
    yanked: bool
    published_at: datetime
    signed: bool
    trust_tier: str
    capabilities: list[str]
    """Declared `manifest.requires` capability allowlist."""
    sensitive_capabilities: list[str]
    """Subset of `capabilities` flagged for elevated scrutiny (fs/terminal)."""


class ExtensionSummary(BaseModel):
    namespace: str
    name: str
    identity: str
    display_name: str | None
    description: str | None
    categories: list[str]
    latest_version: str | None
    updated_at: datetime


class ExtensionDetail(ExtensionSummary):
    publisher: str
    versions: list[VersionInfo]


class ExtensionListResponse(BaseModel):
    items: list[ExtensionSummary]
    total: int
    offset: int
    limit: int


class PublishResponse(BaseModel):
    namespace: str
    name: str
    version: str
    package_digest: str
    yanked: bool


class YankResponse(BaseModel):
    namespace: str
    name: str
    version: str
    yanked: bool


class PublisherRegisterRequest(BaseModel):
    name: str
    public_key: str | None = None
    token: str | None = None
    display_name: str | None = None


class PublisherRegisterResponse(BaseModel):
    name: str
    display_name: str | None
    has_public_key: bool
    has_token: bool


class HealthResponse(BaseModel):
    status: str
