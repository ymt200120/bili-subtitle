# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-08-30

### Fixed

- **Cross-video subtitle contamination** — the reported bug where each click on
  「提取字幕」 produced different subtitles, sometimes from another video:
  - Player-resource capture no longer has an unvalidated fallback: captured
    URLs without ownership evidence are never probed, regardless of whether an
    in-tab navigation happened. Ownership = URL embeds the current `cid`, or
    embeds the current `aid` on a single-page video (`ownsUrl` in
    `src/resolvers/player-resource.js`). Multi-page videos share one `aid`
    across parts, so aid-only matches (potentially another part's subtitles)
    are rejected.
  - The merged track list shown in the panel is ownership-filtered as well, so
    a foreign URL can no longer be offered in the track dropdown.
  - Stale async results can no longer land after an SPA navigation: every
    extract / track load carries a generation token; SPA navigation bumps the
    token (discarding in-flight results) and releases the busy state so the
    new video can be extracted immediately.
  - Multi-page `__INITIAL_STATE__` no longer silently falls back to the first
    part's cid when the requested page is missing; video contexts now carry
    `pageCount`.
  - `clearResult` also clears the track dropdown options and diagnostics text
    (no leftover UI from the previous video).

### Changed

- Behavior trade-off: a captured subtitle URL that embeds neither `cid` nor
  `aid` (possible for some human CC URLs) is no longer used as a last-resort
  fallback, even when it provably came from the current video. Correctness
  (never showing another video's subtitles) wins over fallback coverage; the
  diagnostics panel explains the rejection.
- Userscript header now declares `@noframes`.

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
