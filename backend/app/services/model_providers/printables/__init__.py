"""Public Printables interoperability via its first-party GraphQL API."""

from __future__ import annotations

import asyncio
import re
from dataclasses import replace
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit

import httpx

from backend.app.core.permissions import Permission

from ..base import (
    ModelProvider,
    ProviderAuthConfig,
    ProviderAuthError,
    ProviderAuthType,
    ProviderDownload,
    ProviderDownloadInfo,
    ProviderForbiddenError,
    ProviderNotFoundError,
    ProviderResolvedModel,
    ProviderResourceRef,
    ProviderService,
    ProviderStatus,
    ProviderUnavailableError,
    ProviderUrlError,
)
from ..online import HEADERS, fetch_asset, validate_model_file

API = "https://api.printables.com/graphql/"
CDN_HOSTS = ("media.printables.com", "files.printables.com")
CARD_FIELDS = "id name slug likesCount downloadCount user { publicUsername } image { filePath }"
DETAIL_FIELDS = (
    CARD_FIELDS
    + """
 description license { name } images { filePath }
 stls { id name fileSize } otherFiles { id name fileSize }
 gcodes { id name fileSize } slas { id name fileSize }
"""
)


def image_url(image: dict | None) -> str | None:
    path = (image or {}).get("filePath")
    if not isinstance(path, str) or not path:
        return None
    if path.startswith("https://"):
        return path
    return "https://media.printables.com/" + path.lstrip("/")


def card(model: dict) -> dict:
    return {
        "provider": "printables",
        "id": str(model["id"]),
        "title": model.get("name") or "Untitled model",
        "url": f"https://www.printables.com/model/{model['id']}",
        "creator": (model.get("user") or {}).get("publicUsername") or "Unknown creator",
        "thumbnail": image_url(model.get("image")),
        "downloads": model.get("downloadCount"),
        "likes": model.get("likesCount"),
    }


class PrintablesService(ProviderService):
    def __init__(self, *, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=30, follow_redirects=False)
        self._owns_client = client is None

    async def close(self):
        if self._owns_client:
            await self._client.aclose()

    async def get_status(self, db) -> ProviderStatus:
        return ProviderStatus(authenticated=False, can_download=True)

    async def _graphql(self, query: str, variables: dict | None = None) -> dict:
        try:
            response = await self._client.post(
                API, json={"query": query, "variables": variables or {}}, headers=HEADERS, follow_redirects=False
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError("Printables request failed or timed out") from exc
        if response.status_code == 401:
            raise ProviderAuthError("Printables requires authentication for this resource")
        if response.status_code == 403:
            raise ProviderForbiddenError("Printables refused access to this resource; it may be restricted")
        if response.status_code == 404:
            raise ProviderNotFoundError("Printables model or file was not found")
        if response.status_code == 429:
            raise ProviderUnavailableError("Printables rate-limited this request. Try again later.")
        if response.status_code != 200:
            raise ProviderUnavailableError(f"Printables returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderUnavailableError("Printables returned non-JSON data") from exc
        if not isinstance(payload, dict) or payload.get("errors") or not isinstance(payload.get("data"), dict):
            raise ProviderUnavailableError(
                "Printables could not fulfil this query; its API may have changed or access is restricted"
            )
        return payload["data"]

    async def browse(
        self, *, query: str = "", sort: str = "trending", category: str | None = None, offset: int = 0, limit: int = 24
    ) -> dict[str, Any]:
        ordering = {"trending": "popular", "popular": "popular", "newest": "latest", "relevance": "best_match"}.get(
            sort
        )
        if ordering is None:
            raise ProviderUrlError("Unsupported Printables sort")
        data = await self._graphql(
            """query Browse($q:String!,$limit:Int,$offset:Int,$order:SearchChoicesEnum,$category:ID) {
          searchPrints2(query:$q,printType:print,limit:$limit,offset:$offset,ordering:$order,categoryId:$category) {
            totalCount items { """
            + CARD_FIELDS
            + " } } }",
            {"q": query, "limit": limit, "offset": offset, "order": ordering, "category": category or None},
        )
        result = data.get("searchPrints2")
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise ProviderUnavailableError("Printables returned an invalid model list")
        hits = result["items"]
        total = result.get("totalCount")
        return {
            "items": [card(m) for m in hits if isinstance(m, dict) and m.get("id")],
            "total": total if isinstance(total, int) else None,
            "has_more": offset + len(hits) < total if isinstance(total, int) else len(hits) == limit,
        }

    async def categories(self) -> list[dict[str, str]]:
        data = await self._graphql("{ categories { id name } }")
        if not isinstance(data.get("categories"), list):
            raise ProviderUnavailableError("Printables returned invalid categories")
        return [{"id": str(c["id"]), "name": c["name"]} for c in data["categories"] if c.get("id") and c.get("name")]

    async def detail(self, model_id: str) -> dict[str, Any]:
        data = await self._graphql(
            "query Detail($id:ID!) { print(id:$id) { " + DETAIL_FIELDS + " } }", {"id": model_id}
        )
        model = data.get("print")
        if not isinstance(model, dict):
            raise ProviderNotFoundError("This Printables model is deleted, private, or unavailable")
        files = []
        for group, kind in (("stls", "stl"), ("otherFiles", "other"), ("gcodes", "gcode"), ("slas", "sla")):
            for file in model.get(group) or []:
                name = file.get("name") or "unnamed"
                ext = PurePosixPath(name).suffix.lower().lstrip(".")
                files.append(
                    {
                        "id": f"{kind}:{file['id']}",
                        "name": name,
                        "format": ext or kind,
                        "size": file.get("fileSize"),
                        "sliceable": ext in ("stl", "3mf"),
                        "metadata": {"file_group": kind},
                    }
                )
        return {
            **card(model),
            "description_html": model.get("description") or "",
            "images": [u for img in (model.get("images") or [])[:40] if (u := image_url(img))],
            "license": (model.get("license") or {}).get("name"),
            "files": files,
            "metadata": {},
        }

    async def resolve(self, ref: ProviderResourceRef) -> ProviderResolvedModel:
        return ProviderResolvedModel(ref=ref, design=await self.detail(ref.external_id))

    async def get_download(self, ref: ProviderResourceRef) -> ProviderDownloadInfo:
        detail = await self.detail(ref.external_id)
        selected = next((f for f in detail["files"] if f["id"] == ref.sub_id), None)
        if selected is None:
            raise ProviderNotFoundError("Select a file belonging to this Printables model")
        kind, file_id = selected["id"].split(":", 1)
        data = await self._graphql(
            """mutation Download($id:ID!,$model:ID!,$type:DownloadFileTypeEnum!) {
          getDownloadLink(id:$id,printId:$model,fileType:$type,source:model_detail) {
            ok errors { field messages } output { link }
          }
        }""",
            {"id": file_id, "model": ref.external_id, "type": kind},
        )
        result = data.get("getDownloadLink") or {}
        link = (result.get("output") or {}).get("link")
        if not result.get("ok") or not isinstance(link, str) or not link:
            raise ProviderForbiddenError(
                "Printables did not grant a download for this file. It may require sign-in or be restricted."
            )
        return ProviderDownloadInfo(
            ref=replace(ref, sub_id=selected["id"]), url=link, suggested_filename=selected["name"]
        )

    async def download(self, info: ProviderDownloadInfo) -> ProviderDownload:
        data, _ = await fetch_asset(self._client, info.url, CDN_HOSTS)
        await asyncio.to_thread(validate_model_file, data, info.suggested_filename)
        return ProviderDownload(file_bytes=data, filename=info.suggested_filename)

    async def fetch_thumbnail(self, url: str) -> tuple[bytes, str]:
        return await fetch_asset(self._client, url, CDN_HOSTS, image=True)


class PrintablesProvider(ModelProvider):
    source_type = "printables"
    display_name = "Printables"
    host_patterns = ("printables.com",)
    default_folder_name = "Printables"
    view_permission = Permission.LIBRARY_READ_OWN
    import_permission = Permission.LIBRARY_UPLOAD
    auth = ProviderAuthConfig(auth_type=ProviderAuthType.NONE, display_label="Public models")

    async def build_service(self, *, db, user, api_key_owner=None, client=None) -> ProviderService:
        return PrintablesService(client=client)

    def parse_url(self, url: str) -> ProviderResourceRef:
        try:
            parsed = urlsplit(url if "://" in url else "https://" + url)
            match = re.match(r"^/(?:[a-z]{2}/)?model/(\d+)(?:[-/]|$)", parsed.path)
            if (
                parsed.scheme != "https"
                or parsed.hostname not in ("printables.com", "www.printables.com")
                or parsed.port not in (None, 443)
                or parsed.username
                or parsed.password
                or not match
            ):
                raise ValueError()
        except ValueError as exc:
            raise ProviderUrlError("Enter a valid HTTPS Printables model URL") from exc
        return ProviderResourceRef(source_type=self.source_type, external_id=match.group(1), original_url=url)

    def canonical_url(self, ref: ProviderResourceRef) -> str:
        url = f"https://www.printables.com/model/{ref.external_id}"
        return url + (f"#file-{ref.sub_id}" if ref.sub_id else "")

    def source_url_filter(self, column, external_id: str):
        url = self.canonical_url(ProviderResourceRef(self.source_type, external_id))
        return (column == url) | column.like(url + "#file-%")

    def thumbnail_hosts(self) -> tuple[str, ...]:
        return CDN_HOSTS

    def download_hosts(self) -> tuple[str, ...]:
        return CDN_HOSTS


printables_provider = PrintablesProvider()
