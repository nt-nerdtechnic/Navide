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


class HealthResponse(BaseModel):
    status: str
