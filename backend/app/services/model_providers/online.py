"""Shared public catalogue cache and bounded, allowlisted asset transport.

No arbitrary proxy, redirects, cookies or provider tokens are forwarded to CDNs.
"""

from __future__ import annotations

import asyncio
import copy
import io
import struct
import time
import zipfile
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit

import httpx

from .base import ProviderUnavailableError, ProviderUrlError

HEADERS = {
    "User-Agent": "Bambuddy/1.0 (+https://github.com/1337faye/bambuddy-model-search)",
    "Accept": "application/json",
}
MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
_cache: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()
_cache_locks = [asyncio.Lock() for _ in range(32)]


async def cached(key: tuple, loader: Callable[[], Awaitable[Any]], ttl: float = 120) -> Any:
    # Only successful PUBLIC metadata is cached, never downloads or credentials.
    # Coalesce identical queries without allowing one failed provider to block
    # the other. Fixed stripes bound lock memory across arbitrary search terms.
    async with _cache_locks[hash(key) % len(_cache_locks)]:
        now = time.monotonic()
        item = _cache.get(key)
        if item and item[0] > now:
            _cache.move_to_end(key)
            return copy.deepcopy(item[1])
        result = await loader()
        _cache[key] = (time.monotonic() + ttl, copy.deepcopy(result))
        _cache.move_to_end(key)
        while len(_cache) > 128:
            _cache.popitem(last=False)
        return result


def validate_asset_url(url: str, hosts: tuple[str, ...]) -> None:
    try:
        p = urlsplit(url)
        valid = (
            p.scheme == "https" and p.hostname in hosts and p.port in (None, 443) and not p.username and not p.password
        )
    except ValueError:
        valid = False
    if not valid:
        raise ProviderUrlError("Refusing an asset URL outside this provider's HTTPS CDN allowlist")


async def fetch_asset(
    client: httpx.AsyncClient, url: str, hosts: tuple[str, ...], *, image: bool = False
) -> tuple[bytes, str]:
    validate_asset_url(url, hosts)
    cap = MAX_IMAGE_BYTES if image else MAX_FILE_BYTES
    try:
        async with client.stream(
            "GET", url, headers={"User-Agent": HEADERS["User-Agent"]}, follow_redirects=False, timeout=60
        ) as response:
            if response.status_code != 200:
                raise ProviderUnavailableError(
                    f"Provider asset returned HTTP {response.status_code}; redirects are not followed"
                )
            mime = response.headers.get("content-type", "").split(";")[0].lower()
            if image and mime not in ("image/jpeg", "image/png", "image/webp", "image/gif", "application/octet-stream"):
                raise ProviderUnavailableError("Provider returned non-image content")
            length = response.headers.get("content-length", "")
            if length.isdigit() and int(length) > cap:
                raise ProviderUnavailableError("Provider asset exceeds the size limit")
            data = bytearray()
            async for chunk in response.aiter_bytes():
                if len(data) + len(chunk) > cap:
                    raise ProviderUnavailableError("Provider asset exceeds the size limit")
                data.extend(chunk)
    except httpx.HTTPError as exc:
        # Do not include signed URLs in errors or logs.
        raise ProviderUnavailableError("Provider asset request failed or timed out") from exc
    payload = bytes(data)
    if image:
        mime = image_mime(payload)
    return payload, mime


def image_mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    raise ProviderUnavailableError("Provider did not return a supported raster image")


def validate_model_file(data: bytes, filename: str) -> None:
    """Reject HTML, corrupt projects, traversal/zip bombs before library parsing.

    Archives are inspected in-place, never extracted. Preserve the entire 3MF
    byte-for-byte (including plates, paint and project material assignments).
    """
    if not data or len(data) > MAX_FILE_BYTES:
        raise ProviderUnavailableError("Model file is empty or exceeds 200 MB")
    suffix = PurePosixPath(filename).suffix.lower()
    if data.lstrip().lower().startswith((b"<!doctype html", b"<html", b'{"error')):
        raise ProviderUnavailableError("Provider returned an error page instead of a model")
    if suffix == ".3mf":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 10000 or sum(x.file_size for x in entries) > 1024 * 1024 * 1024:
                    raise ValueError("Archive expansion exceeds limit")
                for item in entries:
                    name = item.filename.replace("\\", "/")
                    if name.startswith("/") or ".." in PurePosixPath(name).parts or item.flag_bits & 1:
                        raise ValueError("Unsafe archive entry")
                    if item.file_size > max(1024 * 1024, item.compress_size * 1000):
                        raise ValueError("Archive compression ratio exceeds limit")
                if not any(x.filename.lower().endswith(".model") for x in entries):
                    raise ValueError("No 3MF model data")
                # CRC verification streams entries without expanding into memory.
                if archive.testzip() is not None:
                    raise ValueError("Corrupt archive")
        except (zipfile.BadZipFile, ValueError, RuntimeError, OSError, EOFError) as exc:
            raise ProviderUnavailableError("Provider returned an invalid or unsafe 3MF project") from exc
    elif suffix == ".stl":
        binary = len(data) >= 84 and 84 + struct.unpack_from("<I", data, 80)[0] * 50 == len(data)
        ascii_stl = (
            data.lstrip().lower().startswith(b"solid") and b"facet" in data.lower() and b"endsolid" in data.lower()
        )
        if not (binary or ascii_stl):
            raise ProviderUnavailableError("Provider returned an invalid STL file")
