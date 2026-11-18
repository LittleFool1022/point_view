# Repository Guidelines

## Project Overview

Point View Survey Studio is an offline-first Windows architectural-surveying workbench. Its primary workflow is complete point cloud → unit/coordinate verification → cleanup/sectioning → plans and elevations → dimensions/annotations → CAD delivery. BIM/IFC, keyframe review, local rendering, device import, and local AI are optional extensions; they must not become prerequisites for CAD export.

The UI is Chinese-language React. Preserve source provenance and review status: parsing, interoperability, or synthetic test success is not engineering accuracy or construction acceptance. Treat `README.md` as current product guidance; parts of `docs/architecture.md` and the Muse document are historical design records.

## Architecture & Data Flow

- **Renderer:** `src/main.tsx` bootstraps `src/App.tsx`, the central coordinator for project state, workers, history, stale-output gates, and cross-workspace callbacks.
- **Native layer:** `electron/main.cjs` owns dialogs, device HTTP, PDF generation, IPC, and one `SourceStore`. `electron/preload.cjs` exposes the only bridge as `window.surveyDesktop`; its TypeScript contract is `src/env.d.ts`.
- **Browser fallback:** `src/platform.ts` implements file-input/download behavior when the Electron bridge is absent. Keep native and browser paths behaviorally aligned.
- **Analysis:** `src/analysisClient.ts` owns the renderer request/cancel protocol and native ranged-read forwarding. `src/pipeline/analysis.worker.ts` decodes and retains the complete cloud. `src/CloudView.tsx` renders only a deterministic preview (maximum 120,000 points). Cleaning, brush edits, drawing, elevations, and model extraction must use full-source/original point indices, never preview samples.
- **Domain:** `src/domain/` contains schema-bearing models, validation, persistence, delivery, building operations, and review logic. Shared CAD and point-cloud code is imported intentionally from `../src/cad`, `../src/components`, and `../src/domain` outside this directory.
- **Delivery:** CAD, IFC, render, and unified exports derive from identified source/model revisions. `.pvplan` projects retain source data and optional keyframe pages; delivery archives do not replace the project as the complete provenance record.

Typical native import flow: `App` obtains an opaque source token and SHA-256 → the worker requests ranged reads through preload IPC → `SourceStore` verifies bounds/stat/hash → full data stays in the worker → transferable preview arrays reach React/Three.js. Edits update clips/model revisions and invalidate dependent outputs. Save/export returns through the platform bridge.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/` | React workspaces, Three.js views, platform adapter, and application coordinator |
| `src/domain/` | Project schemas, source/building/review invariants, validation, IFC, accuracy, and delivery |
| `src/pipeline/` | Full-source workers, decoding, wall/elevation analysis, brush indexing, and local semantic inference |
| `electron/` | Main/preload CommonJS, streaming `SourceStore`, device receiver, close guard, and PDF renderer |
| `../src/cad/` | Shared CAD geometry, sheets, dimensions, preview, and DXF packaging; changes affect consumers beyond this app |
| `tests/` | Vitest `*.test.ts` and Playwright `*.spec.ts`; shared helpers and fixtures |
| `scripts/` | Targeted validation/capture-packaging utilities, not a uniform general-purpose CLI suite |
| `public/ai-evaluation/` | Local model/runtime inputs copied into the Vite build for offline inference |
| `test-data/real-capture/` | Real-capture manifest and benchmark documentation; originals are immutable |
| `docs/` | Product contracts and historical design/acceptance records |
| `dist/`, `release/`, `artifacts/` | Generated build, package, screenshot, diagnostic, and review outputs; do not edit as source |

## Development Commands

Run from this directory with the parent repository intact.

```sh
npm ci
npm run dev                 # Vite at http://127.0.0.1:4186
npm run lint                # AST architecture, IPC parity, and safety guardrails
npm run check               # lint + strict TS no-emit check
npm run build               # lint, strict TS no-emit check, then Vite build to dist/
npm run preview             # serves the existing build on port 4186
npm run desktop             # build, then launch Electron
npm test                    # Vitest: tests/*.test.ts
npm run test:ui             # ordinary Playwright project; build first after source changes
npm run test:ui:external    # real-data/Electron specs with separately visible environment skips
npm run pack:win            # Windows x64 NSIS + ZIP into release/
npm run measure:baseline    # diagnostic artifact only, not an accuracy acceptance test
```

For the documented local Playwright browser cache:

```sh
PLAYWRIGHT_BROWSERS_PATH=../.tools/playwright npm run test:ui
```

There is no separate formatter, coverage, or general Electron-test script. `npm run check` runs guardrails + strict typecheck (`npm run build` also enforces both; `.githooks/pre-commit` provides a ready hook for Git repos). Playwright starts `npm run preview` itself; it does not build and requires port 4186 to be free (`reuseExistingServer: false`).

Example targeted validation/capture utility:

```sh
../node_modules/.bin/vite-node scripts/package-paired-capture.ts \
  <capture-root> <output-directory> [label]
```

Check each script's arguments, fixture paths, and environment variables before running; several remain fixed-artifact validations. TypeScript scripts are included in `npm run build` typechecking.

## Code Conventions & Common Patterns

- **Language/modules:** Strict TypeScript, ES2022, bundler resolution, automatic React JSX. Renderer/config/tests use ESM; Electron files deliberately use `.cjs`/`require` because the package is `"type": "module"`.
- **Naming:** React workspaces/views use `PascalCase.tsx`; domain and pipeline modules use `camelCase.ts`; prefer named exports and existing `PascalCase` types. Test suffix determines the runner.
- **Formatting:** No formatter is configured. Match the touched file's compact style rather than reformatting unrelated code.
- **State management:** No Redux or external store. Cross-view state belongs in `App.tsx` via `useState`; workers, pending requests, epochs, and callbacks use `useRef`. Child workspaces receive typed props/callbacks rather than a dependency-injection framework.
- **History:** Clip, building, and dimension undo/redo stacks are separate. Preserve their invalidation and cap behavior instead of merging them into a generic history without evidence.
- **Async:** `AnalysisClient.request()` serializes analysis-worker requests with numeric IDs and rejects stale-worker completion after cancellation. IFC and semantic inference use separate worker protocols. Use `try`/`catch`/`finally` around busy state and subscriptions; throw actionable `Error` messages, normally Chinese at UI boundaries.
- **Cancellation/staleness:** Terminate workers and advance sequence/epoch guards so old completions cannot overwrite newer edits. Main-process native work uses `AbortController`; preserve atomic `.part`-file save semantics and cleanup.
- **Coordinates:** Domain geometry is meters, Z-up. Convert to millimeters only at the CAD boundary. Paper scale changes layout, never measurement geometry. Keep geodetic double-precision coordinates separate from GPU-local Float32 origins.
- **Provenance:** Never modify original captures. Preserve source SHA-256, units, clips, analysis parameters, evidence kind, model/source revisions, and uncertainty/review flags. Do not infer measured confidence from fit scores or hashes.
- **Derived output:** Geometry/source/model edits invalidate old drawings, IFC, accuracy results, and renders. Paper-only restyling should preserve geometry and manual dimensions. Never silently replace model-derived CAD with point-cloud-derived geometry.
- **Validation/export:** `UNREVIEWED` may be valid for review output but not delivery; other building validation issues are fatal. Corrupt hash/state/cross-file references must reject import without replacing the current project.
- **Security:** Renderer Node integration stays disabled. Add native capabilities across all three matching contracts: `electron/main.cjs`, `electron/preload.cjs`, and `src/env.d.ts`; retain owner checks, sandboxing, and navigation restrictions.

## Important Files

| File | Reason to inspect/change |
| --- | --- |
| `src/App.tsx` | Cross-view state, task/edit ownership, stale/dirty gates, and import/save/export orchestration |
| `src/analysisClient.ts` | Analysis Worker lifecycle, request IDs, native reads, cancellation, and stale-worker isolation |
| `src/projectIo.ts` | Native/browser project read/write with token cleanup and pre-save cancellation checks |
| `src/domain/building.ts` | Meter/Z-up building model, evidence, geometry and relationship validation |
| `src/pipeline/analysis.worker.ts` | Full-source cache and analysis command boundary |
| `src/pipeline/binaryPcd.ts` | Chunked PCD decoding and deterministic preview/source-index mapping |
| `src/pipeline/semanticClient.ts` | Offline model/WASM loading and inference worker protocol |
| `electron/main.cjs` | IPC handlers and native operation serialization |
| `electron/preload.cjs` + `src/env.d.ts` | Desktop bridge implementation and matching renderer types |
| `electron/source-store.cjs` | Native handles, ranged reads, hashes, streaming PVPLAN2/3 persistence |
| `package.json` | Exact dependency pins, scripts, Electron entry, and electron-builder configuration |
| `vite.config.ts` | Parent-repository LAZ alias/filesystem access, ES workers, relative build URLs |
| `README.md` | Current workflows and documented run/test commands |
| `docs/architecture.md` | Detailed invariants; verify historical status against current source |

## Runtime/Tooling Preferences

- Use **npm** with `package-lock.json` and `npm ci`; dependencies are exact-pinned. Node.js 22+ is required by `package.json` and `.nvmrc`; do not switch to Bun/Yarn/pnpm.
- This is not a standalone copyable app. `tsconfig.json` extends `../tsconfig.app.json`; source imports and Vite filesystem access cross into the parent repository.
- On a fresh Windows checkout, install parent-repository dependencies first: `@point-view/lazperf-loader` resolves to `../node_modules/@loaders.gl/las/dist/lazperf-loader.js`.
- Vite targets ES2022, uses `base: "./"`, and emits ES-module workers. Preserve packaged `dist/ai-evaluation` and hashed WASM assets required for offline inference.
- Electron packaging includes only `dist/**/*`, `electron/**/*`, and `package.json`; output goes to `release/`. Packaging success alone is not Windows install, GPU, device, or surveying acceptance.

## Testing & QA

- **Vitest:** Node-side unit/integration coverage for decoding, domain geometry, corruption rejection, streaming persistence, device transfer, IFC, and delivery. Tests run serially in one fork.
- **Playwright:** Headless Chromium workflows at 1600×1000, one worker, 60-second timeout; failure output goes to `artifacts/ui`. The default `chromium` project excludes environment-dependent specs. Use `npm run test:ui:external` for those specs and report their skips separately. `tests/studioPage.ts` is the shared navigation helper.
- Run the narrowest relevant tests, then the affected end-to-end workflow:

```sh
npm test -- tests/pipeline.test.ts
npm run build
npm run test:ui -- tests/workspace.spec.ts
npm run test:ui -- tests/workspace.spec.ts -g "选区先预览"
```

- Use `src/domain/demo.ts`, `tests/fixtures/keyframe.jpg`, and `tests/fixtures/openings.ts` for deterministic synthetic coverage. Do not present synthetic results as validation of the 20-million-point real capture.
- Real-data/Electron specs run only in the `external` project and require inputs such as `PAIRED_WORKSPACE`, `PAIRED_TRI_WORKSPACE`, or `SURVEY_DEVICE_REPLAY`. The device replay spec launches Electron and needs a display/windowing environment; offline semantic tests intentionally block non-loopback network access.
- There is no numeric coverage threshold. Preserve behavioral checks for source hashes, persistence round-trips, corrupt-input rejection, cancellation, stale-output prevention, export contents, and browser `pageerror` absence.
- `npm run measure:baseline` records known geometric deviation; it must not be converted into a passing engineering-accuracy assertion. Independent field dimensions, target CAD/BIM checks, and construction acceptance remain separate evidence.
