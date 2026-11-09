"""Catalogue normalization and real transport/security boundaries (no live IO)."""

import io
import json
import struct
import zipfile

import httpx
import pytest

from backend.app.services.model_providers.base import (
    ProviderForbiddenError,
    ProviderNotFoundError,
    ProviderResourceRef,
    ProviderUnavailableError,
    ProviderUrlError,
)
from backend.app.services.model_providers.makerworld.service import MakerWorldService
from backend.app.services.model_providers.online import fetch_asset, validate_asset_url, validate_model_file
from backend.app.services.model_providers.printables import PrintablesService, printables_provider


def valid_stl():
    return b"\0" * 80 + struct.pack("<I", 1) + b"\0" * 50


def valid_3mf():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            "3D/3dmodel.model", '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>'
        )
        archive.writestr("Metadata/project_settings.config", '{"filament_colour":["#FF0000","#00FF00"]}')
    return output.getvalue()


@pytest.mark.parametrize(
    "url",
    [
        "http://media.printables.com/a",
        "https://media.printables.com:8443/a",
        "https://media.printables.com.evil.example/a",
        "https://127.0.0.1/a",
        "https://media.printables.com@127.0.0.1/a",
        "https://user:pass@media.printables.com/a",
        "file:///etc/passwd",
        "https://[::1]/a",
        "https://169.254.169.254/latest/meta-data",
    ],
)
def test_rejects_unsafe_asset_urls(url):
    with pytest.raises(ProviderUrlError):
        validate_asset_url(url, ("media.printables.com",))


@pytest.mark.asyncio
async def test_asset_redirect_is_not_followed_and_no_credentials_sent():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(302, headers={"location": "http://127.0.0.1/secret"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ProviderUnavailableError):
            await fetch_asset(
                client, "https://media.printables.com/model.stl?signature=secret", ("media.printables.com",)
            )
    assert len(requests) == 1
    assert "authorization" not in requests[0].headers


@pytest.mark.asyncio
async def test_image_sniff_and_declared_size_cap():
    for headers, data in [
        ({"content-type": "image/png"}, b"<html>fake</html>"),
        ({"content-type": "image/png", "content-length": str(11 * 1024 * 1024)}, b"\x89PNG\r\n\x1a\n"),
    ]:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda r, headers=headers, data=data: httpx.Response(200, headers=headers, content=data)
            )
        ) as client:
            with pytest.raises(ProviderUnavailableError):
                await fetch_asset(client, "https://media.printables.com/a.png", ("media.printables.com",), image=True)


def test_content_validation_preserves_project_materials():
    original = valid_3mf()
    validate_model_file(original, "project.3mf")
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        assert b"#00FF00" in archive.read("Metadata/project_settings.config")
    validate_model_file(valid_stl(), "model.stl")


@pytest.mark.parametrize(
    "data,name",
    [
        (b"<html>blocked</html>", "test.stl"),
        (b"PK\x03\x04broken", "test.3mf"),
        (b"solid garbage", "test.stl"),
        (b"", "test.stl"),
    ],
)
def test_invalid_model_bytes_rejected(data, name):
    with pytest.raises(ProviderUnavailableError):
        validate_model_file(data, name)


def test_unsafe_archive_and_zip_bomb_rejected():
    for name, data in [("../escape.model", b"unsafe"), ("3D/model.model", b"x" * (2 * 1024 * 1024))]:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(name, data)
        with pytest.raises(ProviderUnavailableError):
            validate_model_file(output.getvalue(), "project.3mf")


@pytest.mark.asyncio
async def test_printables_search_normalizes_sort_category_pagination():
    def handler(request):
        body = json.loads(request.content)
        assert body["variables"] == {"q": "vase", "limit": 12, "offset": 24, "order": "latest", "category": "13"}
        return httpx.Response(
            200,
            json={
                "data": {
                    "searchPrints2": {
                        "totalCount": 40,
                        "items": [
                            {
                                "id": "42",
                                "name": "Vase",
                                "user": {"publicUsername": "Maker"},
                                "image": {"filePath": "media/vase.jpg"},
                                "downloadCount": 123,
                            }
                        ],
                    }
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await PrintablesService(client=client).browse(
            query="vase", sort="newest", category="13", offset=24, limit=12
        )
    assert result["has_more"] is True
    assert result["items"][0]["thumbnail"] == "https://media.printables.com/media/vase.jpg"
    assert result["items"][0]["creator"] == "Maker"


@pytest.mark.asyncio
async def test_printables_details_and_file_membership():
    model = {
        "id": "42",
        "name": "Vase",
        "description": "<p>Useful</p>",
        "license": {"name": "CC BY"},
        "stls": [{"id": "5", "name": "vase.stl", "fileSize": 134}],
        "otherFiles": [{"id": "6", "name": "project.3mf"}, {"id": "7", "name": "readme.pdf"}],
    }
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"data": {"print": model}}))
    ) as client:
        service = PrintablesService(client=client)
        detail = await service.detail("42")
        assert detail["license"] == "CC BY"
        assert [f["sliceable"] for f in detail["files"]] == [True, True, False]
        with pytest.raises(ProviderNotFoundError):
            await service.get_download(ProviderResourceRef("printables", "42", "stl:999"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(429),
        httpx.Response(500),
        httpx.Response(200, json={"errors": [{"message": "schema changed"}]}),
        httpx.Response(200, text="challenge"),
    ],
)
async def test_printables_failures_are_not_empty_success(response):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response)) as client:
        with pytest.raises(ProviderUnavailableError):
            await PrintablesService(client=client).browse(query="vase")


@pytest.mark.asyncio
async def test_protected_printables_download_is_clear_failure():
    def handler(request):
        body = json.loads(request.content)
        data = (
            {"print": {"id": "42", "stls": [{"id": "5", "name": "vase.stl"}]}}
            if "Detail" in body["query"]
            else {"getDownloadLink": {"ok": False, "errors": [{"field": "auth", "messages": ["Sign in"]}]}}
        )
        return httpx.Response(200, json={"data": data})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ProviderForbiddenError):
            await PrintablesService(client=client).get_download(ProviderResourceRef("printables", "42", "stl:5"))


@pytest.mark.parametrize("url", ["https://www.printables.com/model/3161-3d-benchy", "printables.com/model/3161"])
def test_printables_url_and_canonical_dedupe(url):
    ref = printables_provider.parse_url(url)
    assert ref.external_id == "3161"
    assert (
        printables_provider.canonical_url(ProviderResourceRef("printables", "3161", "stl:5"))
        == "https://www.printables.com/model/3161#file-stl:5"
    )


@pytest.mark.asyncio
async def test_makerworld_uses_working_search_service_not_design_search():
    def handler(request):
        assert request.url.path == "/v1/search-service/select/design2"
        assert request.url.params["categories"] == "100"
        assert request.url.params["offset"] == "24"
        assert request.url.params["orderBy"] == "downloadCount"
        return httpx.Response(
            200,
            json={
                "hits": [
                    {
                        "id": 42,
                        "title": "Vase",
                        "designCreator": {"name": "Creator"},
                        "cover": "https://makerworld.bblmw.com/v.jpg",
                    }
                ],
                "total": 100,
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        data = await MakerWorldService(client=client).browse(query="vase", sort="popular", category="100", offset=24)
    assert data["items"][0]["provider"] == "makerworld"
    assert data["has_more"]


@pytest.mark.asyncio
async def test_makerworld_trending_and_recent_are_genuine_filters():
    urls = []

    def handler(request):
        urls.append(request.url)
        return httpx.Response(200, json={"hits": [], "total": 0})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = MakerWorldService(client=client)
        await service.browse(sort="trending")
        await service.browse(sort="newest")
    assert urls[0].path.endswith("/select/design/nav")
    assert urls[0].params["navKey"] == "Trending"
    assert urls[1].params["designCreateSince"] == "1"


@pytest.mark.asyncio
async def test_makerworld_profiles_preserve_plates_filaments_and_x2d_compatibility():
    def handler(request):
        if request.url.path.endswith("/instances"):
            return httpx.Response(200, json={"hits": [], "total": 0})
        return httpx.Response(
            200,
            json={
                "id": 42,
                "title": "Colour vase",
                "instances": [
                    {
                        "profileId": 5,
                        "title": "X2D",
                        "extention": {
                            "modelInfo": {
                                "compatibility": {"devModelName": "N6", "devProductName": "X2D"},
                                "plates": [
                                    {
                                        "index": 1,
                                        "filaments": [{"id": "1", "color": "#FF0000"}, {"id": "2", "color": "#00FF00"}],
                                    }
                                ],
                            }
                        },
                    }
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        detail = await MakerWorldService(client=client).detail("42")
    profile = detail["files"][0]
    assert profile["id"] == "5"
    assert profile["metadata"]["printer"]["devModelName"] == "N6"
    assert len(profile["metadata"]["plates"][0]["filaments"]) == 2
