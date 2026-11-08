"""MakerWorld's public search-service (NOT the empty design/search API).

Live-checked with anonymous, honestly identified HTTP requests. No CAPTCHA or
Cloudflare workaround. Downloading remains in MakerWorldService's existing path.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode


def card(design: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": "makerworld",
        "id": str(design["id"]),
        "title": design.get("title") or "Untitled model",
        "url": f"https://makerworld.com/en/models/{design['id']}",
        "creator": (design.get("designCreator") or {}).get("name") or "Unknown creator",
        "thumbnail": design.get("coverUrl") or design.get("cover") or None,
        "downloads": design.get("downloadCount"),
        "likes": design.get("likeCount"),
    }


async def browse(
    service, *, query: str = "", sort: str = "trending", category: str | None = None, offset: int = 0, limit: int = 24
) -> dict[str, Any]:
    params: dict[str, Any] = {"keyword": query, "offset": offset, "limit": limit}
    if category:
        params["categories"] = category
    if sort == "popular":
        params["orderBy"] = "downloadCount"
    elif sort == "newest":
        # Upstream ignores guessed 'newest' sort keys. Its documented-by-client
        # recent filter really works; UI labels this provider's option Recent
        # (24 hours), not a fictitious all-time chronological ordering.
        params["designCreateSince"] = 1
    if not query and not category and sort == "trending":
        params["navKey"] = "Trending"
        path = "/select/design/nav"
    else:
        path = "/select/design2"
    envelope = await service._get_json("/search-service" + path + "?" + urlencode(params))
    hits = envelope.get("hits") or []
    if not isinstance(hits, list):
        from ..base import ProviderUnavailableError

        raise ProviderUnavailableError("MakerWorld returned an invalid search response")
    items = [card(hit) for hit in hits if isinstance(hit, dict) and hit.get("id")]
    total = envelope.get("total")
    return {
        "items": items,
        "total": total if isinstance(total, int) else None,
        "has_more": offset + len(hits) < total if isinstance(total, int) else len(hits) == limit,
    }


async def categories(service) -> list[dict[str, str]]:
    root = await service._get_json("/design/category")
    result = []

    def walk(nodes, parent=""):
        for node in nodes:
            name = f"{parent} / {node['name']}" if parent else node["name"]
            result.append({"id": str(node["id"]), "name": name})
            walk(node.get("children") or [], name)

    walk(root.get("children") or [])
    return result


async def detail(service, model_id: str) -> dict[str, Any]:
    from ..base import ProviderResourceRef

    resolved = await service.resolve(ProviderResourceRef(source_type="makerworld", external_id=model_id))
    design = resolved.design
    by_profile = {str(i.get("profileId")): i for i in design.get("instances") or [] if isinstance(i, dict)}
    # Design contains richer project, plate and material data than /instances.
    for instance in resolved.instances:
        if isinstance(instance, dict) and instance.get("profileId"):
            key = str(instance["profileId"])
            by_profile[key] = {**instance, **by_profile.get(key, {})}
    files = []
    for pid, instance in by_profile.items():
        if not pid.isdigit() or int(pid) <= 0:
            continue
        info = (instance.get("extention") or {}).get("modelInfo") or {}
        files.append(
            {
                "id": pid,
                "name": instance.get("title") or f"Print profile {pid}",
                "format": "3mf",
                "size": (info.get("f3mf") or {}).get("size") or None,
                "sliceable": True,
                "metadata": {
                    "printer": info.get("compatibility") or instance.get("compatibility"),
                    "compatible_printers": info.get("otherCompatibility") or instance.get("otherCompatibility"),
                    "plates": info.get("plates") or [],
                    "settings": info.get("projectSettings") or {},
                    "filaments": instance.get("instanceFilaments") or [],
                    "requires_ams": instance.get("needAms", False),
                    "creator": (instance.get("instanceCreator") or instance.get("creator") or {}).get("name"),
                },
            }
        )
    ext = design.get("designExtension") or {}
    images = [
        p["url"]
        for key in ("design_pictures", "real_pictures")
        for p in ext.get(key) or []
        if isinstance(p, dict) and p.get("url")
    ]
    return {
        **card(design),
        "description_html": design.get("summary") or "",
        "images": images[:40],
        "license": design.get("license"),
        "files": files,
        "metadata": {
            "categories": design.get("categories") or [],
            "tags": design.get("tags") or [],
            "originals": design.get("originals") or [],
            "attribution": design.get("licenseDescriptionInfo"),
        },
    }
