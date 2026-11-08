"""Save versus transient Slice integration using the actual library persistence."""

from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from backend.app.api.routes import models
from backend.app.models.library import LibraryFile
from backend.app.services.model_providers.base import ProviderDownload, ProviderDownloadInfo, ProviderResourceRef
from backend.tests.unit.test_models_online import valid_stl


def service():
    svc = AsyncMock()
    svc.detail.return_value = {
        "provider": "printables",
        "id": "42",
        "title": "Vase",
        "creator": "Designer",
        "license": "CC BY",
        "url": "https://www.printables.com/model/42",
        "files": [{"id": "stl:5", "name": "vase.stl", "sliceable": True, "format": "stl", "metadata": {}}],
    }
    svc.get_download.return_value = ProviderDownloadInfo(
        ProviderResourceRef("printables", "42", "stl:5"), "https://files.printables.com/vase.stl", "vase.stl"
    )
    svc.download.return_value = ProviderDownload(valid_stl(), "vase.stl")
    return svc


@pytest.mark.asyncio
async def test_save_persists_attribution_and_deduplicates_without_slicing(async_client, db_session):
    svc = service()
    with (
        patch.object(models.registry.get("printables"), "build_service", AsyncMock(return_value=svc)),
        patch("backend.app.api.routes.library._render_stl_thumbnail", AsyncMock(return_value=None)),
        patch("backend.app.api.routes.library.slice_and_persist", AsyncMock()) as slice_fn,
    ):
        first = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "save"}
        )
        assert first.status_code == 200, first.text
        second = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "save"}
        )
    assert second.json()["library_file_id"] == first.json()["library_file_id"]
    assert second.json()["was_existing"] is True
    assert first.json()["temporary"] is False
    svc.download.assert_awaited_once()
    slice_fn.assert_not_called()
    row = await db_session.get(LibraryFile, first.json()["library_file_id"])
    assert row.source_type == "printables"
    assert row.file_metadata["online_model"]["license"] == "CC BY"
    assert row.source_url.endswith("#file-stl:5")


@pytest.mark.asyncio
async def test_slice_source_is_hidden_and_cleanup_cannot_delete_saved_model(async_client, db_session):
    svc = service()
    with (
        patch.object(models.registry.get("printables"), "build_service", AsyncMock(return_value=svc)),
        patch("backend.app.api.routes.library._render_stl_thumbnail", AsyncMock(return_value=None)),
    ):
        saved = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "save"}
        )
        prepared = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "slice"}
        )
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["temporary"]
    tmp_id = prepared.json()["library_file_id"]
    saved_id = saved.json()["library_file_id"]
    assert tmp_id != saved_id
    listing = await async_client.get("/api/v1/library/files/", params={"include_root": False})
    assert tmp_id not in [r["id"] for r in listing.json()]
    assert saved_id in [r["id"] for r in listing.json()]
    assert (await async_client.delete(f"/api/v1/models/temporary/{saved_id}")).status_code == 404
    assert (await async_client.delete(f"/api/v1/models/temporary/{tmp_id}")).status_code == 204
    assert (await async_client.delete(f"/api/v1/models/temporary/{tmp_id}")).status_code == 204
    trash = await async_client.get("/api/v1/library/trash")
    assert str(tmp_id) not in [str(item["id"]) for item in trash.json().get("files", [])]
    db_session.expire_all()
    assert (
        await db_session.execute(select(LibraryFile).where(LibraryFile.id == saved_id))
    ).scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_wrong_file_unsupported_and_invalid_destination_rejected(async_client):
    svc = service()
    with patch.object(models.registry.get("printables"), "build_service", AsyncMock(return_value=svc)):
        response = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:99", "action": "slice"}
        )
        assert response.status_code == 404
        svc.detail.return_value["files"][0]["sliceable"] = False
        response = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "slice"}
        )
        assert response.status_code == 400
        response = await async_client.post(
            "/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "slice", "folder_id": 2}
        )
        assert response.status_code == 400
    svc.download.assert_not_awaited()


@pytest.mark.asyncio
async def test_bad_ids_and_provider_are_not_proxy_targets(async_client):
    assert (await async_client.get("/api/v1/models/evil/browse")).status_code == 404
    assert (await async_client.get("/api/v1/models/printables/not-a-number")).status_code == 400
    assert (await async_client.get("/api/v1/models/printables/browse", params={"offset": -1})).status_code == 422
    assert (
        await async_client.get("/api/v1/models/printables/thumbnail", params={"url": "http://127.0.0.1/secret"})
    ).status_code == 400
