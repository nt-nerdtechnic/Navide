"""Repository abstraction over the SQLModel session.

Keeps all query/mutation logic in one place so the storage engine and query
strategy can evolve without touching the API layer.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlmodel import Session, select

from .models import Extension, ExtensionAsset, ExtensionVersion, Publisher


def _now() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(token: str) -> str:
    """Stable sha256 hash of a bearer token (we never store it in the clear)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class RegistryRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    # -- publishers -----------------------------------------------------
    def get_or_create_publisher(
        self, name: str, display_name: str | None = None
    ) -> Publisher:
        publisher = self.session.exec(
            select(Publisher).where(Publisher.name == name)
        ).first()
        if publisher is None:
            publisher = Publisher(name=name, display_name=display_name)
            self.session.add(publisher)
            self.session.commit()
            self.session.refresh(publisher)
        return publisher

    def get_publisher_by_token(self, token: str) -> Publisher | None:
        return self.session.exec(
            select(Publisher).where(Publisher.token_hash == hash_token(token))
        ).first()

    def register_publisher(
        self,
        *,
        name: str,
        public_key: str | None = None,
        token: str | None = None,
        display_name: str | None = None,
    ) -> Publisher:
        """Create or update a publisher's registered key / bearer token."""
        publisher = self.session.exec(
            select(Publisher).where(Publisher.name == name)
        ).first()
        if publisher is None:
            publisher = Publisher(name=name)
        if display_name is not None:
            publisher.display_name = display_name
        if public_key is not None:
            publisher.public_key = public_key
        if token is not None:
            publisher.token_hash = hash_token(token)
        self.session.add(publisher)
        self.session.commit()
        self.session.refresh(publisher)
        return publisher

    # -- extensions -----------------------------------------------------
    def get_extension(self, namespace: str, name: str) -> Extension | None:
        return self.session.exec(
            select(Extension).where(
                Extension.namespace == namespace, Extension.name == name
            )
        ).first()

    def get_or_create_extension(
        self,
        *,
        publisher: Publisher,
        namespace: str,
        name: str,
        display_name: str | None,
        description: str | None,
        categories: list[str],
    ) -> Extension:
        extension = self.get_extension(namespace, name)
        if extension is None:
            extension = Extension(
                publisher_id=publisher.id,
                namespace=namespace,
                name=name,
                identity=f"{namespace}.{name}",
                display_name=display_name,
                description=description,
                categories=categories,
            )
            self.session.add(extension)
            self.session.commit()
            self.session.refresh(extension)
        else:
            # Keep discovery metadata in sync with the newest publish.
            extension.display_name = display_name
            extension.description = description
            extension.categories = categories
            extension.updated_at = _now()
            self.session.add(extension)
            self.session.commit()
            self.session.refresh(extension)
        return extension

    def search_extensions(
        self,
        *,
        query: str | None = None,
        offset: int = 0,
        limit: int = 20,
    ) -> tuple[list[Extension], int]:
        """Keyword search over name/description/categories, newest first.

        Returns (page, total_matches).
        """
        stmt = select(Extension)
        if query:
            like = f"%{query.lower()}%"
            candidates = self.session.exec(stmt).all()
            matched = [e for e in candidates if _matches(e, like)]
            matched.sort(key=lambda e: e.updated_at, reverse=True)
            total = len(matched)
            return matched[offset : offset + limit], total

        all_rows = self.session.exec(stmt).all()
        all_rows.sort(key=lambda e: e.updated_at, reverse=True)
        total = len(all_rows)
        return all_rows[offset : offset + limit], total

    # -- versions -------------------------------------------------------
    def get_version(
        self, extension_id: int, version: str
    ) -> ExtensionVersion | None:
        return self.session.exec(
            select(ExtensionVersion).where(
                ExtensionVersion.extension_id == extension_id,
                ExtensionVersion.version == version,
            )
        ).first()

    def list_versions(self, extension_id: int) -> list[ExtensionVersion]:
        return list(
            self.session.exec(
                select(ExtensionVersion).where(
                    ExtensionVersion.extension_id == extension_id
                )
            ).all()
        )

    def add_version(
        self,
        *,
        extension: Extension,
        version: str,
        manifest: dict,
        package_digest: str,
        package_key: str,
        signature: str | None,
        trust_tier: str,
        assets: list[tuple[str, int, str]],
    ) -> ExtensionVersion:
        record = ExtensionVersion(
            extension_id=extension.id,
            version=version,
            manifest=manifest,
            package_digest=package_digest,
            package_key=package_key,
            signature=signature,
            trust_tier=trust_tier,
        )
        self.session.add(record)
        self.session.commit()
        self.session.refresh(record)
        for path, size, content_type in assets:
            self.session.add(
                ExtensionAsset(
                    version_id=record.id,
                    path=path,
                    size=size,
                    content_type=content_type,
                )
            )
        self.session.commit()
        self.session.refresh(record)
        return record

    def yank_version(self, version_row: ExtensionVersion) -> ExtensionVersion:
        version_row.yanked = True
        self.session.add(version_row)
        self.session.commit()
        self.session.refresh(version_row)
        return version_row

    def list_assets(self, version_id: int) -> list[ExtensionAsset]:
        return list(
            self.session.exec(
                select(ExtensionAsset).where(
                    ExtensionAsset.version_id == version_id
                )
            ).all()
        )


def _matches(extension: Extension, like: str) -> bool:
    needle = like.strip("%")
    haystack = " ".join(
        [
            extension.name.lower(),
            (extension.display_name or "").lower(),
            (extension.description or "").lower(),
            " ".join(extension.categories).lower(),
        ]
    )
    return needle in haystack
