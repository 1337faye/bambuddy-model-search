"""Opt-in live checks against a disposable, auth-disabled local Bambuddy.

Run: .venv/bin/python scripts/verify_online_models.py
Only discovery is default. --download saves real public models into the local
library; --slice enqueues a real X2D slice (never prints). No credentials needed.
"""

import argparse
import asyncio
import json
from urllib.parse import urlsplit

import httpx


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/api/v1")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--slice", action="store_true")
    args = parser.parse_args()
    if urlsplit(args.base_url).hostname not in ("127.0.0.1", "localhost"):
        parser.error("Use a disposable local instance, not a production server")
    async with httpx.AsyncClient(base_url=args.base_url + "/", timeout=120) as client:

        async def request(method, path, **kwargs):
            response = await client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json() if response.content else None

        for provider in ("makerworld", "printables"):
            results = await request(
                "GET", f"models/{provider}/browse", params={"query": "benchy", "sort": "relevance", "limit": 3}
            )
            assert results["items"], f"{provider}: no real search results"
            item = results["items"][0]
            detail = await request("GET", f"models/{provider}/{item['id']}")
            assert detail["files"] and detail["title"]
            image = await client.get(f"models/{provider}/thumbnail", params={"url": item["thumbnail"]})
            image.raise_for_status()
            assert image.headers["content-type"].startswith("image/")
            popular = await request("GET", f"models/{provider}/browse", params={"sort": "popular", "limit": 2})
            categories = await request("GET", f"models/{provider}/categories")
            assert popular["items"] and categories
            print(
                f"{provider}: search, popular, categories, detail, {len(detail['files'])} files/profiles, raster image OK"
            )
        if args.download or args.slice:
            data = {"file_id": "stl:2074193", "action": "slice" if args.slice else "save"}
            source = await request("POST", "models/printables/481177/prepare", json=data)
            print("Downloaded actual public Printables 3MF:", source)
            if not args.slice:
                duplicate = await request("POST", "models/printables/481177/prepare", json=data)
                assert duplicate["was_existing"] and duplicate["library_file_id"] == source["library_file_id"]
                print("Save deduplication OK; no slicing requested")
                return
            def preset(name):
                return {"source": "standard", "id": name}
            job = await request(
                "POST",
                f"library/files/{source['library_file_id']}/slice",
                json={
                    "printer_preset": preset("Bambu Lab X2D 0.4 nozzle"),
                    "process_preset": preset("0.20mm Standard @BBL X2D"),
                    "filament_presets": [preset("Bambu PLA Basic @BBL X2D 0.4 nozzle")],
                    "filament_colours": ["#00AE42"],
                    "auto_arrange": True,
                },
            )
            await request("DELETE", f"models/temporary/{source['library_file_id']}")
            for _ in range(120):
                state = await request("GET", f"slice-jobs/{job['job_id']}")
                if state["status"] in ("completed", "failed", "cancelled"):
                    print(json.dumps(state, indent=2))
                    assert state["status"] == "completed", "Actual slicer failed"
                    assert state["result"]["print_time_seconds"] > 0
                    return
                await asyncio.sleep(2)
            raise TimeoutError("Slice still running after four minutes")


if __name__ == "__main__":
    asyncio.run(main())
