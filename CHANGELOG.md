# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2026-09-04

### Fixed

- Hide the floating subtitle button and panel while Bilibili is in web
  fullscreen mode (player container `data-screen="web"`).
- Restore the subtitle button after leaving web fullscreen or native
  fullscreen (Fullscreen API); if the panel was open when entering an
  immersive mode it stays closed afterwards.
- Wide-screen mode (`data-screen="wide"`) remains unaffected: the button
  stays visible.

## [1.0.3] - 2026-08-30

### Changed

- Distribution metadata only: the userscript name is now
  `Bilibili CC / AI Subtitle Extractor`, with localized
  `@name:zh-CN` / `@description:zh-CN` (English default description) so
  Chinese and English distribution pages (e.g. Greasy Fork) display properly.
  Note: userscript managers identify scripts by name + namespace, so the new
  name installs as a separate entry — remove the previously installed copy
  if both appear.
- No resolver, WBI signer, protobuf, player-resource, contextKey, SPA, UI or
  exporter behavior changes.

## [1.0.2] - 2026-08-30

> Real-browser repro after v1.0.1: on one video, consecutive extractions
> returned a DIFFERENT video's subtitles, then the correct ones. v1.0.1
> hardened player-resource ownership and stale SPA handling, but did not
> cover incorrect yet syntactically valid responses from the unsigned
> legacy player endpoint (`/x/player/v2`).

### Fixed

- **Trust model for resolvers** (`src/core/model.js`, `src/resolvers/index.js`):
  availability is no longer authority. Tracks are stamped with a trust level
  (`SIGNED_METADATA` / `CURRENT_VIDEO_METADATA` / `CURRENT_PLAYER_RESOURCE` /
  `UNTRUSTED_LEGACY`) and a `contextKey` (bvid:cid). A track can become the
  winner or enter the selectable dropdown only when its trust is winnable AND
  its contextKey matches the current video — fail closed.
- **Unsigned legacy endpoint demoted to a diagnostic probe**
  (`src/resolvers/legacy.js`): independently reported (risk-control
  degradation) to answer HTTP 200 with valid-looking subtitles belonging to a
  different video. It still runs concurrently (metadata only) for comparison
  and login hints, but its body is never fetched, it can never win, and its
  tracks never appear in the dropdown.
- **Commit-time guards** (`src/main.js`): a result is applied only when both
  the generation token is current AND the page still parses to the video the
  result belongs to; track changes are refused (fail closed) unless the track
  passes the trust/contextKey check.
- **Player-resource navigation epoch** (`src/resolvers/player-resource.js`):
  captured entries carry the SPA navigation epoch; only current-epoch entries
  are considered, in addition to the existing ownership check.
- **SPA reset precision** (`src/core/spa.js`): the reset now fires only when
  the video identity (bvid/page) actually changes, instead of on every
  pushState/replaceState (URL normalization no longer wipes results).

### Added

- **Signed WBI resolver** (`src/resolvers/signed-wbi.js`, new primary):
  `/x/player/wbi/v2` with real WBI signing — `src/core/md5.js` (self-contained
  RFC 1321 MD5, constants hardcoded after observing engine-precision drift in
  the `Math.sin` formula) and `src/core/wbi.js` (nav key fetch incl. anonymous
  `code -101` responses, 15-min key cache, invalidation on `-352`/`-403`/HTTP
  412 with exactly one retry). Anonymous and logged-in endpoint behavior is
  pending browser validation (docs/PROTOCOL.md §2b).
- **Diagnostics** (`src/core/diagnostics.js`, `src/resolvers/index.js`): every
  extract run has a `run #N`; the panel shows Context (bvid/aid/cid/contextKey),
  per-resolver steps with trust levels, and an explicit Winner/Decision block;
  console logs carry `[bili-subtitle] [run:N]`. A diagnostic-only cross-check
  warns when the untrusted legacy probe disagrees with the trusted result.
- Tests: 24 new cases covering the regression above (valid-but-wrong HTTP 200
  legacy response must never win), WBI signer vectors (RFC 1321 + community
  protocol reference), key cache/invalidation, contextKey mismatch, epoch
  rejection and multi-page ownership. 72 total.

### Changed

- Resolver order is now **signed-wbi → web-view → player-resource**, with
  legacy-json as a metadata-only diagnostic probe. Users whose only working
  source was the unsigned endpoint may now get a precise failure instead of a
  possibly-wrong subtitle — that is the intended trade-off (`no result >
  wrong result`).

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
- Archived pre-1.0 prototype at `docs/prototype/1.js` (since removed from the
  repository; preserved in git history)

[1.0.0]: https://github.com/ymt200120/bili-subtitle/releases/tag/v1.0.0
