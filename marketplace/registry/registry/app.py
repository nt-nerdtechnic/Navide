"""FastAPI application for the marketplace registry."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import Engine
from sqlmodel import Session

from .auth import PublisherIdentity, get_publisher_identity
from .config import Settings, load_settings
from .db import create_db_engine
from .models import Extension, ExtensionVersion, Publisher
from .package import PackageError, read_package
from .repository import RegistryRepository
from .schemas import (
    ExtensionDetail,
    ExtensionListResponse,
    ExtensionSummary,
    HealthResponse,
    PublishResponse,
    VersionInfo,
    YankResponse,
)
from .signing import AcceptingSignatureVerifier, SignatureVerifier
from .storage import LocalStorageBackend, StorageBackend, StorageError
from .versions import latest_version


@dataclass
class RegistryState:
    engine: Engine
    storage: StorageBackend
    verifier: SignatureVerifier


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    state = RegistryState(
        engine=create_db_engine(settings.db_path),
        storage=LocalStorageBackend(settings.storage_root),
        verifier=AcceptingSignatureVerifier(),
    )

    app = FastAPI(title="Navide Marketplace Registry", version="0.1.0")
    app.state.registry = state

    _register_routes(app)
    return app


# -- dependencies -------------------------------------------------------
def _state(request: Request) -> RegistryState:
    return request.app.state.registry


def _session(state: RegistryState = Depends(_state)) -> Iterator[Session]:
    with Session(state.engine) as session:
        yield session


def _repo(session: Session = Depends(_session)) -> RegistryRepository:
    return RegistryRepository(session)


# -- helpers ------------------------------------------------------------
def _package_key(namespace: str, name: str, version: str) -> str:
    return f"{namespace}/{name}/{version}/package.vsix"


def _version_info(row: ExtensionVersion) -> VersionInfo:
    return VersionInfo(
        version=row.version,
        package_digest=row.package_digest,
        yanked=row.yanked,
        published_at=row.published_at,
        signed=row.signature is not None,
    )


def _summary(extension: Extension, versions: list[ExtensionVersion]) -> ExtensionSummary:
    active = [v.version for v in versions if not v.yanked]
    return ExtensionSummary(
        namespace=extension.namespace,
        name=extension.name,
        identity=extension.identity,
        display_name=extension.display_name,
        description=extension.description,
        categories=extension.categories,
        latest_version=latest_version(active),
        updated_at=extension.updated_at,
    )


def _register_routes(app: FastAPI) -> None:
    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.post("/api/publish", response_model=PublishResponse, status_code=201)
    async def publish(
        request: Request,
        package: UploadFile,
        signature: str | None = None,
        identity: PublisherIdentity = Depends(get_publisher_identity),
        repo: RegistryRepository = Depends(_repo),
    ) -> PublishResponse:
        state: RegistryState = request.app.state.registry
        data = await package.read()
        try:
            loaded = read_package(data)
        except PackageError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        # Signature seam: recorded now, real verification is p3-security.
        if not state.verifier.verify(data, signature):
            raise HTTPException(status_code=400, detail="invalid package signature")

        manifest = loaded.manifest
        namespace = manifest.namespace
        name = manifest.extension_name

        publisher = repo.get_or_create_publisher(manifest.publisher)
        extension = repo.get_or_create_extension(
            publisher=publisher,
            namespace=namespace,
            name=name,
            display_name=manifest.displayName or manifest.name,
            description=manifest.description,
            categories=manifest.categories,
        )

        if repo.get_version(extension.id, manifest.version) is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"version {manifest.version} of {extension.identity} "
                    "already exists"
                ),
            )

        key = _package_key(namespace, name, manifest.version)
        state.storage.put(key, data)
        row = repo.add_version(
            extension=extension,
            version=manifest.version,
            manifest=manifest.model_dump(),
            package_digest=loaded.digest,
            package_key=key,
            signature=signature,
            assets=[(a.path, a.size, a.content_type) for a in loaded.assets],
        )
        return PublishResponse(
            namespace=namespace,
            name=name,
            version=row.version,
            package_digest=row.package_digest,
            yanked=row.yanked,
        )

    @app.get("/api/extensions", response_model=ExtensionListResponse)
    def list_extensions(
        q: str | None = None,
        offset: int = 0,
        limit: int = 20,
        repo: RegistryRepository = Depends(_repo),
    ) -> ExtensionListResponse:
        limit = max(1, min(limit, 100))
        offset = max(0, offset)
        rows, total = repo.search_extensions(query=q, offset=offset, limit=limit)
        items = [_summary(e, repo.list_versions(e.id)) for e in rows]
        return ExtensionListResponse(
            items=items, total=total, offset=offset, limit=limit
        )

    @app.get(
        "/api/extensions/{namespace}/{name}", response_model=ExtensionDetail
    )
    def extension_detail(
        namespace: str,
        name: str,
        repo: RegistryRepository = Depends(_repo),
    ) -> ExtensionDetail:
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        versions = repo.list_versions(extension.id)
        summary = _summary(extension, versions)
        publisher_name = _publisher_name(repo, extension)
        ordered = sorted(
            versions, key=lambda v: v.published_at, reverse=True
        )
        return ExtensionDetail(
            **summary.model_dump(),
            publisher=publisher_name,
            versions=[_version_info(v) for v in ordered],
        )

    @app.get("/api/extensions/{namespace}/{name}/{version}/download")
    def download(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        repo: RegistryRepository = Depends(_repo),
    ) -> StreamingResponse:
        state: RegistryState = request.app.state.registry
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        row = repo.get_version(extension.id, version)
        if row is None:
            raise HTTPException(status_code=404, detail="version not found")
        try:
            stream = state.storage.open_stream(row.package_key)
        except StorageError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        filename = f"{namespace}.{name}-{version}.vsix"
        return StreamingResponse(
            stream,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Package-Digest": row.package_digest,
            },
        )

    @app.post(
        "/api/extensions/{namespace}/{name}/{version}/yank",
        response_model=YankResponse,
    )
    def yank(
        namespace: str,
        name: str,
        version: str,
        identity: PublisherIdentity = Depends(get_publisher_identity),
        repo: RegistryRepository = Depends(_repo),
    ) -> YankResponse:
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        row = repo.get_version(extension.id, version)
        if row is None:
            raise HTTPException(status_code=404, detail="version not found")
        row = repo.yank_version(row)
        return YankResponse(
            namespace=namespace, name=name, version=version, yanked=row.yanked
        )


def _publisher_name(repo: RegistryRepository, extension: Extension) -> str:
    publisher = repo.session.get(Publisher, extension.publisher_id)
    return publisher.name if publisher else extension.namespace


# Module-level app for `uvicorn registry.app:app`.
app = create_app()
