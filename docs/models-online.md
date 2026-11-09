# Models: online discovery, Save and Slice

The existing **Model Sources** destination is now **Models**. Its route remains
`/model-sources`; `/makerworld` and old `?tab=makerworld` bookmarks still open the
original MakerWorld URL importer. There is one sidebar item, not another model
library. **Open Library** leads to the existing File Manager. Manyfold remains
available with its existing configuration and permission checks.

## Browse and inspect

Discover loads real results without a keyword. Search both sources together or
select MakerWorld or Printables. Each source has independent pagination and
errors: a failure in one does not replace the other with empty results. The
query, filters, page offsets and selected model live in the URL, so refresh and
back/forward navigation retain their meaning. Search is debounced; obsolete
fetches are aborted through TanStack Query. Only one page per source is rendered.

Single-provider browsing exposes the provider's actual categories. Popularity,
relevance and recent/newest selection use upstream fields, not client-side sorting
of a small result page. MakerWorld's **Recent · last 24 hours** is a real recent
upload filter, not an assertion that its API supports all-time chronological
sorting. Printables offers Popular rather than a fabricated separate Trending
ranking. The unified view identifies each source and its effective ordering.

Details include a raster-image gallery, sanitized formatted description, license,
creator and original listing. MakerWorld lists its individual print profiles,
printer compatibility, plates and material data. Where configured printers are
visible, prioritize profiles for one of their models. Provider-declared X2D/N6
compatibility is not a claim about the installed slicer's capabilities. Printables
lists STL, project, gcode and other files separately. Choose one deliberately;
unrelated files are never silently combined.

## Save versus Slice

**Save to Library** downloads the selected original file/profile into a writable
library folder (or root), stores provider attribution/license in the file's
metadata, and uses the existing library's dedupe/persistence/parser/thumbnail
mechanisms. Save does not fetch slicer presets, configure a printer, slice or
print. Its success link opens and highlights that file in File Manager. A
previously saved, readable copy is returned rather than downloaded again; changing
the destination does not silently duplicate an existing save.

**Slice in Bambuddy** downloads the selected STL/3MF into a managed temporary
library record and immediately opens the existing `SliceModal`. No manual Save
step, desktop application, second downloader, or printer-control subsystem is
involved. Temporary inputs have `source_type=online_slice`, are excluded from
normal file lists/statistics, and are never dedupe candidates for permanent saves.
The client releases them on cancel or successful enqueue. The slice endpoint
captures source bytes before returning the job ID, so cleanup cannot invalidate a
queued job. An hourly sweeper expires abandoned inputs after 24 hours, including
across application restarts. Cleanup checks ownership and managed-path containment;
it cannot remove an ordinary saved library record.

The existing SliceModal supplies printer/process/filament selection, plate
selection, loaded-spool filters, material/color overrides and job tracking.
Completed results use Bambuddy's existing preview/library/queue/print actions.
**Slice never starts a physical print.** Sliced outputs remain in the library as
normal prepared results; only their temporary source is discarded.

STL and 3MF are directly sliceable. Gcode, bgcode, PDF, STEP and other files are
shown as Save only rather than pretending the CLI can slice them. A downloaded
3MF is retained byte-for-byte, including plate assignments, painted/material
information and embedded project settings. Actual embedded-setting use remains
subject to the existing slicer's compatibility checks and user configuration.

## Provider interfaces

### MakerWorld

The existing `design-service/design/search` really does return empty results
from server requests. Discovery uses a different first-party Bambu interface:

- `api.bambulab.com/v1/search-service/select/design2` for search/popular/categories.
- `.../select/design/nav?navKey=Trending` for the public trending feed.
- `design-service/design/category` for the category hierarchy.
- Existing design/instances endpoints for rich details.
- Existing `MakerWorldService.get_download` / instance `f3mf` mechanism for
  downloads, reusing the stored Bambu Cloud credential and established fallback.

The public catalogue is anonymous and honestly identifies Bambuddy. Downloads
still require the user's existing Bambu Cloud sign-in. There is no CAPTCHA
solver, browser-cookie scraping, TLS impersonation or paid search intermediary.
These are first-party web/client interoperability interfaces, not a promised
stable public API. Upstream restrictions/errors remain visible to the user.

### Printables

`api.printables.com/graphql/` provides anonymous public `searchPrints2`,
`categories`, and `print(id:)` data. `getDownloadLink` resolves a selected file
only after verifying it belongs to that model. The provider owns its GraphQL
transport and is registered in the existing `ModelProviderRegistry`.

Printables' normal website presented a Cloudflare challenge during development;
the public GraphQL interface and public CDN worked directly. No challenge was
bypassed. No credentials were required for the tested public files. Account-only,
club/private/restricted files fail clearly rather than retrying around protection.
There is no new Printables credential vault: account-gated file downloads are
currently unsupported.

## Security and operational notes

- All catalogue/detail/save routes use Bambuddy auth and provider/library
  permissions. MakerWorld retains `makerworld:view`/`makerworld:import`; preparing
  files also requires library upload and read access. Printables reads accept
  granular library read tiers. API keys continue through existing scope/owner gates.
- Public metadata is cached for two minutes (categories one hour), bounded to 128
  entries; credential-bearing/private responses and signed links are not cached.
- Model IDs, categories, query lengths, pagination, file IDs and destinations are
  validated. Selection is rechecked against provider detail data before download.
- New image/download paths accept HTTPS on exact provider CDN hosts, reject URL
  credentials/nonstandard ports, and do not follow redirects. New images are
  streamed with a 10 MiB cap and raster magic-byte checking; SVG/HTML is refused.
- Files are capped at 200 MiB, STL content validated, and 3MF directories checked
  for traversal, encryption, entry count, expansion/ratio limits and CRC damage
  before the existing parser sees them. Archive validation runs off the event loop.
- External HTML is sanitized by DOMPurify with a narrow formatting allowlist;
  external images/embeds/scripts/styles are removed. External links are explicit
  and opened with `noopener noreferrer`.
- Imports use two bounded download slots and fixed-stripe locks to prevent a
  burst of identical saves from redundantly downloading/persisting files.

## Local verification and remaining limits

See [verification results](models-online-verification.md), including actual
commands, live models, screenshots, known baseline test failures and the precise
limits of physical X2D/AMS verification. Run `scripts/verify_online_models.py`
only against a disposable local instance. It defaults to read-only discovery;
`--download` explicitly tests real Save/dedupe, and `--slice` tests an actual
server-side X2D slice without printing.
