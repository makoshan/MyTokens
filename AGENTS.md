# Repository Guidelines (MyKey)

## What To Read First (Project Context)
- Product spec (most important): `/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md`
- FN voice-input plan (if touching hotkeys/voice input): `/Users/thursday/go/play/mykey/Docs_code/fn-voice-input-tech-plan.md`
- User-facing docs/screenshots: `/Users/thursday/go/play/mykey/docs`

If a change conflicts with the product spec, call it out explicitly and propose the smallest fix or spec update.

## Project Structure
- Frontend (Tauri webview): `/Users/thursday/go/play/mykey/src` (React + TS, Vite)
- Backend (Tauri/Rust): `/Users/thursday/go/play/mykey/src-tauri` (Rust commands, local gateway/service, storage/vault)
- Tests (Node test runner / TS linkage): `/Users/thursday/go/play/mykey/tests`
- Reference code/docs (vendored projects, comparisons): `/Users/thursday/go/play/mykey/Docs_code`

## Build, Test, Run
- Install deps: `npm install`
- Frontend dev (web only): `npm run dev`
- Tauri dev: `npm run tauri:dev`
- Tauri build: `npm run tauri:build`
- DMG (universal): `npm run tauri:build:dmg`
- Quick checks:
  - `npm run test:linkage`
  - `npm run test:gateway`

## Engineering Notes
- Security: never log or commit real API keys, cookies, tokens, or user secrets. Prefer redaction in logs and tests.
- Backwards-compat: the gateway should remain OpenAI-compatible where documented; avoid breaking API shapes without a migration path.
- Keep changes scoped: prefer small, testable diffs; update docs when behavior changes.

