"""Unified online catalogue; Save and Slice are deliberately separate intents.

Providers own discovery and downloads. Library persistence, authorization,
visibility, deduplication and temporary slicing sources are shared here.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.cloud import resolve_api_key_cloud_owner
from backend.app.api.routes.library import save_3mf_bytes_to_library
from backend.app.api.routes.makerworld import _authorize_for_provider, _map_service_error
from backend.app.core.auth import (
    ApiKeyActor,
    RequestActor,
    require_actor_still_exists,
    require_auth_if_enabled,
    require_ownership_permission,
    require_permission_if_auth_enabled,
    security,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.row_visibility import owned_row_clauses
from backend.app.models.library import LibraryFile
from backend.app.models.user import User
from backend.app.services.library_folder_access import get_writable_folder
from backend.app.services.model_providers import registry
from backend.app.services.model_providers.base import ProviderError, ProviderResourceRef
from backend.app.services.model_providers.online import cached, fetch_asset, validate_model_file

router = APIRouter(prefix="/models", tags=["models"])
TEMP_SOURCE = "online_slice"
_prepare_slots = asyncio.Semaphore(2)
_prepare_locks = [asyncio.Lock() for _ in range(64)]


class PrepareRequest(BaseModel):
    file_id: str = Field(min_length=1, max_length=80, pattern=r"^(?:stl:|other:|gcode:|sla:)?[1-9][0-9]*$")
    action: Literal["save", "slice"]
    folder_id: int | None = Field(default=None, gt=0)


class PreparedFile(BaseModel):
    library_file_id: int
    filename: str
    folder_id: int | None
    was_existing: bool
    temporary: bool


def provider_for(name: str):
    if name not in ("makerworld", "printables"):
        raise HTTPException(404, "Unknown online model provider")
    return registry.get(name)


async def authorize(provider, credentials, x_api_key, *, importing=False):
    if provider.source_type == "printables":
        await require_ownership_permission(Permission.LIBRARY_READ_ALL, Permission.LIBRARY_READ_OWN)(
            credentials=credentials, x_api_key=x_api_key
        )
        if importing:
            return await require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)(
                credentials=credentials, x_api_key=x_api_key
            )
        return None
    permission = provider.import_permission if importing else provider.view_permission
    user = await _authorize_for_provider(provider, permission, credentials, x_api_key)
    if importing:
        await require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)(
            credentials=credentials, x_api_key=x_api_key
        )
        await require_ownership_permission(Permission.LIBRARY_READ_ALL, Permission.LIBRARY_READ_OWN)(
            credentials=credentials, x_api_key=x_api_key
        )
    return user


def check_id(model_id: str):
    if not model_id.isascii() or not model_id.isdigit() or not 0 < int(model_id) < 2**63:
        raise HTTPException(400, "Invalid model identifier")


async def public_service(provider, db):
    # Public catalogue calls never use the user's bearer. No private model data
    # or signed links can enter the process-wide metadata cache.
    if provider.source_type == "makerworld":
        from backend.app.services.model_providers.makerworld.service import MakerWorldService

        return MakerWorldService()
    return await provider.build_service(db=db, user=None)


@router.get("/{provider_name}/browse", dependencies=[Depends(require_auth_if_enabled)])
async def browse_models(
    provider_name: str,
    query: str = Query(default="", max_length=200),
    sort: Literal["trending", "popular", "newest", "relevance"] = "trending",
    category: str | None = Query(default=None, max_length=12, pattern=r"^[0-9]*$"),
    offset: int = Query(default=0, ge=0, le=9984),
    limit: int = Query(default=24, ge=1, le=48),
    db: AsyncSession = Depends(get_db, scope="function"),
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
):
    provider = provider_for(provider_name)
    await authorize(provider, credentials, x_api_key)
    service = await public_service(provider, db)
    try:
        return await cached(
            (provider_name, "browse", query.strip(), sort, category, offset, limit),
            lambda: service.browse(
                query=query.strip(), sort=sort, category=category or None, offset=offset, limit=limit
            ),
        )
    except ProviderError as exc:
        raise _map_service_error(exc) from exc
    finally:
        await service.close()


@router.get("/{provider_name}/categories", dependencies=[Depends(require_auth_if_enabled)])
async def model_categories(
    provider_name: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
):
    provider = provider_for(provider_name)
    await authorize(provider, credentials, x_api_key)
    service = await public_service(provider, db)
    try:
        return await cached((provider_name, "categories"), service.categories, ttl=3600)
    except ProviderError as exc:
        raise _map_service_error(exc) from exc
    finally:
        await service.close()


@router.get("/{provider_name}/thumbnail")
async def model_thumbnail(provider_name: str, url: str = Query(max_length=3000)):
    # Public catalogue raster images only, like the existing /makerworld proxy.
    provider = provider_for(provider_name)
    service = await public_service(provider, None)
    try:
        payload, mime = await fetch_asset(service._client, url, provider.thumbnail_hosts(), image=True)
    except ProviderError as exc:
        raise _map_service_error(exc) from exc
    finally:
        await service.close()
    return Response(
        payload,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{provider_name}/{model_id}", dependencies=[Depends(require_auth_if_enabled)])
async def model_detail(
    provider_name: str,
    model_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
):
    provider = provider_for(provider_name)
    await authorize(provider, credentials, x_api_key)
    check_id(model_id)
    service = await public_service(provider, db)
    try:
        return await cached((provider_name, "detail", model_id), lambda: service.detail(model_id))
    except ProviderError as exc:
        raise _map_service_error(exc) from exc
    finally:
        await service.close()


async def delete_temporary_row(db: AsyncSession, row: LibraryFile, *, tombstone: bool = False):
    # Temp rows are always managed UUID files, never on a user mount. Refuse
    # anything else even if the row was corrupted. No cascade into saved files.
    if row.source_type != TEMP_SOURCE or row.is_external:
        raise HTTPException(409, "This is not a temporary slicing source")
    from backend.app.api.routes.library import get_library_files_dir, get_library_thumbnails_dir, to_absolute_path

    for raw, directory in (
        (row.file_path, get_library_files_dir()),
        (row.thumbnail_path, get_library_thumbnails_dir()),
    ):
        if raw:
            path = to_absolute_path(raw)
            if path is None or not path.is_relative_to(directory.resolve()):
                raise HTTPException(409, "Temporary file is outside managed storage")
            path.unlink(missing_ok=True)
    if tombstone:
        # Keep the ID reserved until expiry. SQLite otherwise reuses the just
        # removed ID for the slice result, making a job's source_id point to its
        # own output (or a different user's newly uploaded model).
        row.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    else:
        await db.delete(row)


async def expire_temporary_models(db: AsyncSession):
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=24)
    rows = (
        (
            await db.execute(
                select(LibraryFile).where(LibraryFile.source_type == TEMP_SOURCE, LibraryFile.created_at < cutoff)
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        await delete_temporary_row(db, row)
    if rows:
        await db.commit()


async def cleanup_temporary_models_loop():
    import logging

    from backend.app.core.database import async_session

    while True:
        try:
            async with async_session() as db:
                await expire_temporary_models(db)
        except Exception:
            logging.getLogger(__name__).exception("Temporary model cleanup failed")
        await asyncio.sleep(3600)


@router.delete("/temporary/{file_id}", status_code=204, dependencies=[Depends(require_auth_if_enabled)])
async def delete_temporary_model(
    file_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    actor: User | ApiKeyActor | None = RequestActor,
    _user=Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
):
    row = await db.get(LibraryFile, file_id)
    if row is None:
        return Response(status_code=204)
    if row.source_type != TEMP_SOURCE or (actor is not None and row.created_by_id != actor.id):
        raise HTTPException(404, "Temporary source not found")
    await delete_temporary_row(db, row, tombstone=True)
    await db.commit()
    return Response(status_code=204)


@router.post(
    "/{provider_name}/{model_id}/prepare", response_model=PreparedFile, dependencies=[Depends(require_auth_if_enabled)]
)
async def prepare_model(
    provider_name: str,
    model_id: str,
    body: PrepareRequest,
    db: AsyncSession = Depends(get_db, scope="function"),
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    actor: User | ApiKeyActor | None = RequestActor,
    api_key_cloud_owner: User | None = Depends(resolve_api_key_cloud_owner),
):
    provider = provider_for(provider_name)
    current_user = await authorize(provider, credentials, x_api_key, importing=True)
    check_id(model_id)
    if body.action == "slice" and body.folder_id is not None:
        raise HTTPException(400, "Slice uses temporary storage, not a library destination")
    if body.folder_id is not None:
        folder = await get_writable_folder(db, body.folder_id, actor)
        if folder.is_external and folder.external_readonly:
            raise HTTPException(403, "Cannot save to a read-only folder")
    readable = owned_row_clauses(LibraryFile, actor, Permission.LIBRARY_READ_ALL, Permission.LIBRARY_READ_OWN)
    ref = ProviderResourceRef(provider_name, model_id, sub_id=body.file_id)
    source_url = provider.canonical_url(ref)
    owner_id = actor.id if actor else None
    lock = _prepare_locks[hash((owner_id, source_url)) % len(_prepare_locks)]
    async with lock, _prepare_slots:
        await expire_temporary_models(db)
        if body.action == "save" and readable is not None:
            existing = (
                await db.execute(LibraryFile.active().where(LibraryFile.source_url == source_url, *readable).limit(1))
            ).scalar_one_or_none()
            if existing:
                return PreparedFile(
                    library_file_id=existing.id,
                    filename=existing.filename,
                    folder_id=existing.folder_id,
                    was_existing=True,
                    temporary=False,
                )
        service = await provider.build_service(db=db, user=current_user, api_key_owner=api_key_cloud_owner)
        try:
            detail = await service.detail(model_id)
            file = next((f for f in detail["files"] if f["id"] == body.file_id), None)
            if file is None:
                raise HTTPException(404, "The selected file or profile does not belong to this model")
            if body.action == "slice" and not file["sliceable"]:
                raise HTTPException(400, "Only STL and 3MF files can be sliced by the installed pipeline")
            info = await service.get_download(ref)
            download = await service.download(info)
            filename = unquote(info.suggested_filename or download.filename).replace("\\", "/").rsplit("/", 1)[-1]
            if not filename or filename in (".", "..") or len(filename) > 255:
                filename = f"{provider_name}-{model_id}.{file['format']}"
            # Avoid filesystem-control and FAT32-invalid characters. Storage is
            # UUID scoped internally; external destinations use this safe name.
            filename = "".join("_" if ord(c) < 32 or c in '<>:"|?*' else c for c in filename)
            await asyncio.to_thread(validate_model_file, download.file_bytes, filename)
        except ProviderError as exc:
            raise _map_service_error(exc) from exc
        finally:
            await service.close()
        await require_actor_still_exists(db, actor)
        temporary = body.action == "slice"
        row, was_existing = await save_3mf_bytes_to_library(
            db,
            file_bytes=download.file_bytes,
            filename=filename,
            folder_id=None if temporary else body.folder_id,
            source_type=TEMP_SOURCE if temporary else provider_name,
            source_url=None if temporary else source_url,
            owner_id=owner_id,
            dedupe_within=None if temporary else readable,
        )
        if not was_existing:
            row.external_url = detail["url"]
            row.file_metadata = {
                **(row.file_metadata or {}),
                "online_model": {
                    "provider": provider_name,
                    "id": model_id,
                    "file_id": body.file_id,
                    "title": detail["title"],
                    "creator": detail["creator"],
                    "license": detail["license"],
                    "url": detail["url"],
                    "profile": file["metadata"],
                },
            }
            await db.commit()
        return PreparedFile(
            library_file_id=row.id,
            filename=row.filename,
            folder_id=row.folder_id,
            was_existing=was_existing,
            temporary=temporary,
        )
