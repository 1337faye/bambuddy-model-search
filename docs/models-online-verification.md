# Online Models verification — 8 November 2026

## Running local instance

- Frontend: <http://127.0.0.1:5173/model-sources>
- Backend: `127.0.0.1:8000`, bound to loopback.
- Disposable application data: `/tmp/bambuddy-models-dev` (not a real printer installation).
- Existing slicer API wrapper: `127.0.0.1:3001`, local checkout of
  `maziggy/orca-slicer-api` branch `bambuddy/profile-resolver` under
  `/tmp/models-local-sidecar`. This is the existing Bambuddy sidecar implementation,
  not a new slicer implementation in this PR.
- Actual slicing binary: installed Bambu Studio **02.08.02.61** CLI, using its
  bundled BBL JSON profiles, including genuine X2D presets. No desktop GUI
  automation was used and no physical printer was registered or contacted.

The backend and Vite were started with the repository's documented uvicorn/Vite
commands and existing dependencies. Sidecar setup followed that project's local
macOS instructions: `ORCASLICER_PATH`, `BUNDLED_PROFILES_PATH`, `DATA_PATH`, and
`PORT=3001`, then its built `dist/src/index.js`. Production normally uses the
existing Docker sidecar documented in `slicer-api/README.md`.

## Live checks actually performed

| Check | Result |
|---|---|
| MakerWorld `benchy` search | Real listings, including model 40146, not the known-empty design/search endpoint |
| MakerWorld trending, popular, category tree | Real results/categories |
| MakerWorld model 40146 details | Real title, creator, images, license and 101 print-profile choices at test time |
| MakerWorld raster thumbnail | HTTP 200, decoded in browser |
| MakerWorld authenticated 3MF download | **Not live verified**: disposable instance has no Bambu Cloud credential |
| Printables `benchy` search | Real results including model 3161, 3D BENCHY |
| Printables popular, newest, categories | Real API results/categories |
| Printables model 3161 details | Two gallery images, public-domain license, STL and separate gcode/bgcode files |
| Printables public STL download + Save | Real 11,285,384-byte `3dbenchy.stl` saved and visible in File Manager |
| Save deduplication | Repeated save returned the same existing library file |
| Printables public 3MF | Model **481177**, file **stl:2074193**, `CalibrationCube20mm.3mf`, 56,975 bytes |
| Direct Slice, no manual Save | Browser selected this 3MF, clicked Slice, opened actual SliceModal, chose X2D and enqueued HTTP 202 |
| Actual server-side X2D slice | Completed, `.gcode.3mf` output containing `Metadata/plate_1.gcode` |
| Result estimates | **867 seconds (14m 27s), 3.73 g, 1230.71 mm** |
| Temporary source lifecycle | Hidden from file listing; deleted after enqueue while job completed from captured bytes |
| Mobile detail | 390 × 844 viewport, no horizontal document overflow |
| Physical print | **Not attempted** |

Browser verification used real running application endpoints and provider data,
not intercepted/mocked requests. Screenshots are in `docs/screenshots/models/`.
The automated suite separately uses fixtures and mocked provider transports;
those tests are not counted as live verification.

The final repeat of `scripts/verify_online_models.py --slice` completed after a
local sidecar restart. One intervening run stalled in the optional local Node
sidecar, was terminated by restarting that owned service, and correctly surfaced
as a failed job (502 server disconnected). It was not concealed as a successful
slice. This macOS development-sidecar event has not been reproduced or diagnosed
in the production Docker deployment. The normal repeat, browser run, and initial
CLI/API run produced actual G-code outputs.

## Commands and tests

Dependency installation:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.lock
uv pip install --python .venv/bin/python pytest pytest-asyncio pytest-cov pytest-mock aiosqlite ruff
(cd frontend && npm ci)
```

Installing `requirements.lock` together with `requirements-dev.txt` fails because
this repository pins two different Ruff versions. They were not silently edited;
the commands above provide a usable isolated test environment.

Backend provider/library/security/auth/slicer regression command:

```sh
.venv/bin/pytest -q \
 backend/tests/unit/test_models_online.py \
 backend/tests/unit/test_models_routes.py \
 backend/tests/integration/test_models_permissions.py \
 backend/tests/unit/test_makerworld_routes.py \
 backend/tests/unit/test_makerworld_s3_tls.py \
 backend/tests/integration/test_makerworld_apikey_auth.py \
 backend/tests/integration/test_makerworld_permission_gate.py \
 backend/tests/unit/services/test_makerworld.py \
 backend/tests/unit/services/test_model_provider_interface.py \
 backend/tests/unit/services/test_manyfold_service.py \
 backend/tests/integration/test_manyfold_api.py \
 backend/tests/unit/test_model_provider_registry.py \
 backend/tests/unit/test_slice_output_check_2838.py \
 backend/tests/unit/test_slice_backstop_wiring_2838.py
```

**287 passed** before the final temporary-ID tombstone hardening; its 35-test
Models subset was rerun successfully afterward. These tests include SSRF URL
shapes/redirect rejection, image/file caps, invalid STL/3MF, archive bombs,
provider-error normalization, profile plate/material preservation, auth/ownership,
dedupe, Save-without-slicing, and transient Slice cleanup.

Frontend:

```sh
cd frontend
npm run typecheck
npm run lint
npm run build
npm run check:i18n
npx vitest run \
 src/__tests__/pages/ModelSourcesPage.test.tsx \
 src/__tests__/api/models.test.ts \
 src/__tests__/i18n/modelsBrowse.test.ts \
 src/__tests__/i18n/locale-loading.test.ts \
 src/__tests__/components/Layout.test.tsx \
 src/__tests__/utils/modelProfileCompatibility.test.ts \
 src/__tests__/utils/slicerPrinterMatch.test.ts \
 src/__tests__/components/SliceModal.test.tsx \
 src/__tests__/components/SliceModalLoadedSpools.test.tsx \
 src/__tests__/utils/sliceLoadedSpools.test.ts
```

Typecheck/lint/build/i18n passed; Safari 16 baseline check passed (263 bundles).
Targeted frontend suite: **291 passed, 10 files**. Build-generated `static/`
assets were restored after verification; this PR contains source, not a bundle
churn commit.

Full `npm run test:run`: **5736 passed, 5 failed, 423 files**. The following
failures were reproduced from a clean `git archive main` in a separate temporary
folder with the same installed dependencies (not attributed to this feature):

- `EmbeddedCameraContext.test.tsx`: cached printer-list remount timing (also
  reproduced alone on main; occasionally passes in a grouped baseline run).
- `lazyPage.test.tsx`: missing sessionStorage reload guard.
- `PrintersPage.test.tsx`: small-card plate-clear action.
- `PrintersPageCardScale.test.tsx`: real-element card scaling.
- `StreamOverlayPage.test.tsx`: WebSocket status handler timing.

Live checks:

```sh
.venv/bin/python scripts/verify_online_models.py
.venv/bin/python scripts/verify_online_models.py --slice
# Save/duplicate check was also exercised via POST /models/printables/481177/prepare.
```

Context7 documentation fetch was attempted and refused with monthly quota
exceeded. Official TanStack/DOMPurify documentation and public provider client
references were used instead; no paid service was added.

## Explicit remaining limits

- No real X2D/AMS was available in this isolated instance. Existing loaded-spool,
  material mapping, dual-nozzle and printer-compatibility tests pass, and genuine
  installed X2D profiles completed a real CLI slice. Physical feeder/AMS mapping,
  multicolour print output and printer delivery are **not hardware verified**.
- The live slice model was single-material. Multi-plate/material data retention
  is tested against fixtures and existing SliceModal tests; it is not claimed as
  a live multicolour hardware test.
- MakerWorld Save/download needs the user's existing Bambu Cloud login. No
  authenticated download or full MakerWorld slice is claimed live-tested.
- Printables account-gated/club/private downloads have a clear refusal but no
  new account-login integration. Public downloads work without credentials.
- These first-party web/client APIs can change; schema/refusal errors are
  surfaced. No CAPTCHA/access-control bypass or anti-bot impersonation is used.
- There is no invented Featured feed. MakerWorld Recent is a 24-hour filter;
  Printables has Popular instead of a separate Trending feed. Other unsupported
  provider filters are not offered.
- Selecting multiple unrelated files is deliberately not a combined print.
  Save/Slice currently acts on one explicit file/profile per operation.
- New discovery strings use an explicit shared English fallback for all locales;
  the Models navigation/page heading is translated in every existing locale.
