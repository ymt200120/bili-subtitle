# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-29

### Added

- Single-file userscript (`bili-subtitle.user.js`) with a resilient resolver
  strategy chain:
  - **VideoContext resolver**: page-embedded `__INITIAL_STATE__` with fallback
    to the public view API (`bvid`/`aid`/`cid`/page/title)
  - **Strategy A — LegacyJsonResolver**: `/x/player/v2` subtitle list
  - **Strategy B — WebSubtitleResolver**: `/x/v2/subtitle/web/view` with an
    independent minimal protobuf wire decoder (no protobuf runtime)
  - **Strategy C — PlayerResourceResolver**: event-driven
    `PerformanceObserver` capture of the player's own subtitle requests,
    validated by fetching and cross-checked against the current `aid`/`cid`
- Automatic re-discovery when signed subtitle URLs expire (HTTP 403/404);
  signed URLs are never cached
- Per-step diagnostics (`✓/✗/○` + HTTP status + sanitized endpoint) in the
  panel and in the console under the `[bili-subtitle]` prefix with signed
  parameters masked
- Lightweight UI: a floating "字幕" pill with track picker, preview, export
  actions and a collapsed diagnostics section
- Exports: copy plain text, copy timestamped text, TXT, SRT, JSON
- SPA navigation handling via `history.pushState/replaceState` + `popstate`
  patches (no polling); per-video state and captured resources reset on
  navigation
- Privacy by design: no cookie access, no telemetry, no third-party uploads
- Zero-dependency build (`scripts/build.mjs` + shared packing rule) and a
  zero-dependency test suite (`node --test`), 44 tests covering URL parsing,
  cue parsing, SRT formatting, protobuf decoding (fixtures), resolver
  strategies (mocked network) and log sanitization
- Protocol notes in `docs/PROTOCOL.md` distinguishing verified facts from
  prior-art evidence and pending browser validation
- Archived pre-1.0 prototype at `docs/prototype/1.js`

[1.0.0]: https://github.com/ymt200120/bili-subtitle/releases/tag/v1.0.0
