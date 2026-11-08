from unittest.mock import AsyncMock, patch

import pytest

from backend.app.api.routes import models
from backend.tests.integration.test_makerworld_permission_gate import _make_user, _setup_auth_with_admin
from backend.tests.unit.test_models_routes import service


@pytest.mark.asyncio
async def test_models_anonymous_and_permission_boundaries(async_client):
    admin = await _setup_auth_with_admin(async_client)
    assert (await async_client.get("/api/v1/models/printables/browse")).status_code == 401
    assert (
        await async_client.post("/api/v1/models/printables/42/prepare", json={"file_id": "stl:5", "action": "save"})
    ).status_code == 401
    no_view = await _make_user(async_client, admin, username="noonline", permissions=["printers:read"])
    headers = {"Authorization": f"Bearer {no_view}"}
    assert (await async_client.get("/api/v1/models/printables/browse", headers=headers)).status_code == 403
    assert (await async_client.get("/api/v1/models/makerworld/browse", headers=headers)).status_code == 403
    viewer = await _make_user(async_client, admin, username="onlineviewer", permissions=["library:read_own"])
    response = await async_client.post(
        "/api/v1/models/printables/42/prepare",
        headers={"Authorization": f"Bearer {viewer}"},
        json={"file_id": "stl:5", "action": "save"},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_temporary_source_owner_and_existing_copy_visibility(async_client):
    admin = await _setup_auth_with_admin(async_client)
    permissions = ["library:read_own", "library:upload"]
    first = {
        "Authorization": f"Bearer {await _make_user(async_client, admin, username='onlinea', permissions=permissions)}"
    }
    second = {
        "Authorization": f"Bearer {await _make_user(async_client, admin, username='onlineb', permissions=permissions)}"
    }
    with (
        patch.object(models.registry.get("printables"), "build_service", AsyncMock(return_value=service())),
        patch("backend.app.api.routes.library._render_stl_thumbnail", AsyncMock(return_value=None)),
    ):
        a = await async_client.post(
            "/api/v1/models/printables/42/prepare", headers=first, json={"file_id": "stl:5", "action": "save"}
        )
        b = await async_client.post(
            "/api/v1/models/printables/42/prepare", headers=second, json={"file_id": "stl:5", "action": "save"}
        )
        temp = await async_client.post(
            "/api/v1/models/printables/42/prepare", headers=first, json={"file_id": "stl:5", "action": "slice"}
        )
    assert a.status_code == b.status_code == temp.status_code == 200, (a.text, b.text, temp.text)
    assert a.json()["library_file_id"] != b.json()["library_file_id"]
    path = f"/api/v1/models/temporary/{temp.json()['library_file_id']}"
    assert (await async_client.delete(path, headers=second)).status_code == 404
    assert (await async_client.delete(path, headers=first)).status_code == 204
