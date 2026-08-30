/*
 * Subtitle resolver pipeline.
 *
 * Production chain, in order (first trusted success wins):
 *   1. signed-wbi      /x/player/wbi/v2      (WBI-signed metadata)
 *   2. web-view        /x/v2/subtitle/web/view (protobuf, aid+cid in query)
 *   3. player-resource captured player requests (epoch + ownership proof)
 *
 * The unsigned /x/player/v2 (legacy-json) is NOT part of the chain: it has
 * been reported to return HTTP 200 with valid-looking subtitles belonging
 * to a DIFFERENT video (risk-control degradation). It runs concurrently as
 * a metadata-only diagnostic probe; its tracks are stamped UNTRUSTED_LEGACY
 * and can never become the winner, be loaded, or enter the track dropdown.
 *
 * Every track/result is bound to the video context via contextKey
 * (bvid:cid) and a trust level; only winnable trust + matching contextKey
 * passes the authorization helper. Signed subtitle URLs are never cached:
 * a 403/404 body fetch triggers one extra discovery round with fresh
 * metadata. Every attempt is recorded as a diagnostics step with a runId.
 *
 * env = { net, href, initialState, getEntries, onUpdate, onContext }
 * (all injectable so the whole pipeline runs under node:test with mocks)
 */

const EXPIRY_STATUS = [403, 404];

const TRUST_BY_RESOLVER = {
  'signed-wbi': () => BS.trust.SIGNED,
  'web-view': () => BS.trust.CURRENT_VIDEO,
  'player-resource': () => BS.trust.CURRENT_PLAYER,
  legacy: () => BS.trust.UNTRUSTED_LEGACY
};

function trustOfSource(name) {
  const fn = TRUST_BY_RESOLVER[name];
  return fn ? fn() : '';
}

let runCounter = 0;

function isExpiryError(err) {
  return err && EXPIRY_STATUS.includes(err.status);
}

function now() {
  return Date.now();
}

/*
 * Authorization: a track may be loaded, displayed or selected only when
 * its trust level is winnable AND it is provably bound to the current
 * video context. UNTRUSTED_LEGACY tracks fail this check by design.
 */
function isSelectableTrack(track, ctx) {
  return Boolean(
    track &&
      track.url &&
      ctx &&
      BS.isWinnableTrust(track.trust) &&
      track.contextKey === ctx.contextKey
  );
}

async function loadBody(track, env, tried) {
  if (Array.isArray(track.cues) && track.cues.length) {
    return track.cues;
  }
  if (!track.url || tried.has(track.url)) {
    throw new Error('跳过（已尝试过或无地址）');
  }
  tried.add(track.url);

  const data = await env.net.getJson(track.url, { phase: 'body' });
  const cues = BS.parseSubtitleJson(data);
  if (!cues.length) throw new Error('字幕内容为空');
  return cues;
}

async function runStrategy(resolver, ctx, env, diag, tried) {
  const started = now();

  let result;
  try {
    result = await resolver.discover(ctx, env);
  } catch (e) {
    diag.add({
      resolver: resolver.name,
      status: BS.diagnostics.FAIL,
      detail: e.message,
      httpStatus: e.status,
      endpoint: e.endpoint,
      trust: trustOfSource(resolver.name),
      ms: now() - started
    });
    BS.warn(resolver.name, '失败', e);
    return { tracks: [], retryable: isExpiryError(e) };
  }

  const okDetail = result.note || `${result.tracks.length} 条轨道`;
  diag.add({
    resolver: resolver.name,
    status: result.soft ? BS.diagnostics.SKIP : BS.diagnostics.OK,
    detail: okDetail,
    trust: trustOfSource(resolver.name),
    ms: now() - started
  });

  if (!result.tracks.length) {
    return { tracks: [], retryable: false };
  }

  const candidates = BS.sortTracks(
    result.tracks.filter((t) => !tried.has(t.url))
  );

  let sawExpiry = false;
  for (const track of candidates) {
    // Defense in depth: chain resolvers stamp winnable trust, but never
    // rely on that alone.
    if (!isSelectableTrack(track, ctx)) {
      diag.add({
        resolver: `${resolver.name}#fetch`,
        status: BS.diagnostics.SKIP,
        detail: `轨道未通过信任/归属校验（trust ${track.trust || '缺失'}），跳过`
      });
      continue;
    }
    if (Array.isArray(track.cues) && track.cues.length) {
      diag.add({
        resolver: `${resolver.name}#fetch`,
        status: BS.diagnostics.OK,
        detail: `${track.cues.length} 条（播放器捕获验证）`,
        ms: 0
      });
      return { tracks: result.tracks, doc: { track, cues: track.cues } };
    }
    const bodyStarted = now();
    try {
      const cues = await loadBody(track, env, tried);
      diag.add({
        resolver: `${resolver.name}#fetch`,
        status: BS.diagnostics.OK,
        detail: `${track.lanDoc || track.lan} · ${cues.length} 条`,
        ms: now() - bodyStarted
      });
      return { tracks: result.tracks, doc: { track, cues } };
    } catch (e) {
      diag.add({
        resolver: `${resolver.name}#fetch`,
        status: BS.diagnostics.FAIL,
        detail: e.message,
        httpStatus: e.status,
        endpoint: e.endpoint,
        ms: now() - bodyStarted
      });
      if (isExpiryError(e)) {
        sawExpiry = true;
        BS.warn('字幕地址已过期，将重新获取 metadata', BS.sanitizeUrl(track.url));
      }
    }
  }

  return { tracks: result.tracks, retryable: sawExpiry };
}

/*
 * Diagnostic probe: unsigned legacy metadata, never committed.
 * Metadata only — bodies of UNTRUSTED_LEGACY tracks are never fetched.
 */
async function probeLegacy(ctx, env, diag) {
  const started = now();
  try {
    const result = await BS.resolvers.legacy.discover(ctx, env);
    const count = result.tracks.length;
    diag.add({
      resolver: 'legacy-json(诊断)',
      status: BS.diagnostics.OK,
      detail: `${result.note || `${count} 条轨道`}（未采信：未签名接口不作为结果来源）`,
      trust: BS.trust.UNTRUSTED_LEGACY,
      ms: now() - started
    });
    return { ok: true, tracks: result.tracks };
  } catch (e) {
    diag.add({
      resolver: 'legacy-json(诊断)',
      status: BS.diagnostics.FAIL,
      detail: e.message,
      httpStatus: e.status,
      endpoint: e.endpoint,
      trust: BS.trust.UNTRUSTED_LEGACY,
      ms: now() - started
    });
    return { ok: false, error: e };
  }
}

function buildHints(diagSteps, probe) {
  const okNote = (name) =>
    diagSteps.some(
      (s) =>
        s.resolver === name &&
        s.status === BS.diagnostics.OK &&
        s.detail &&
        !/条轨道/.test(s.detail)
    );

  const notes = [];
  if (probe && probe.ok && probe.tracks.length) {
    notes.push(
      '未签名的 /x/player/v2 此刻返回了轨道，但该接口无法证明字幕归属（曾观测到返回其他视频的字幕），已按策略忽略。'
    );
  }
  if (okNote('signed-wbi') && okNote('web-view')) {
    notes.push('两个可信接口都返回空轨道：AI 字幕通常需要登录 B 站后才能获取。');
  }
  notes.push(
    '兜底提示：在播放器中打开「字幕 / CC」并选择 AI 字幕，让播放器实际加载一次，再点「重新提取」。'
  );
  return notes;
}

async function extract(env) {
  const runId = ++runCounter;
  const runTag = `[run:${runId}]`;
  const diag = BS.diagnostics.createDiagnostics({ runId });
  const tried = new Set();
  env.onUpdate && env.onUpdate(`正在识别视频…（run #${runId}）`);

  let ctx;
  try {
    ctx = await BS.resolvers.videoContext.resolve(env);
  } catch (e) {
    diag.add({
      resolver: 'video-context',
      status: BS.diagnostics.FAIL,
      detail: e.message
    });
    return { ok: false, runId, error: e, tracks: [], diag };
  }
  diag.add({
    resolver: 'video-context',
    status: BS.diagnostics.OK,
    detail: `${ctx.bvid} · aid ${ctx.aid} · cid ${ctx.cid} · P${ctx.page} · key ${ctx.contextKey}`
  });
  diag.setContext(ctx);
  env.onContext && env.onContext(ctx);
  BS.log(
    runTag,
    'context',
    `${ctx.bvid} · aid ${ctx.aid} · cid ${ctx.cid} · P${ctx.page}`,
    `key ${ctx.contextKey}`
  );

  // Untrusted legacy probe runs concurrently with the trusted chain so it
  // never slows the happy path down.
  const legacyProbeP = probeLegacy(ctx, env, diag);

  const strategies = [
    BS.resolvers.signedWbi,
    BS.resolvers.webView,
    BS.resolvers.playerResource
  ];

  let merged = [];
  let doc = null;
  let winnerName = '';
  let retryable = false;

  for (const strategy of strategies) {
    env.onUpdate && env.onUpdate(`正在尝试：${strategy.name}（run #${runId}）`);
    const r = await runStrategy(strategy, ctx, env, diag, tried);
    merged = BS.mergeTracks([merged, r.tracks]);
    if (r.doc) {
      doc = r.doc;
      winnerName = strategy.name;
      break;
    }
    if (r.retryable) retryable = true;
  }

  if (!doc && retryable) {
    env.onUpdate && env.onUpdate(`字幕地址已过期，正在重新获取…（run #${runId}）`);
    for (const strategy of [BS.resolvers.signedWbi, BS.resolvers.webView]) {
      const r = await runStrategy(strategy, ctx, env, diag, tried);
      merged = BS.mergeTracks([merged, r.tracks]);
      if (r.doc) {
        doc = r.doc;
        winnerName = strategy.name;
        break;
      }
    }
  }

  const probe = await legacyProbeP;

  // Belt and suspenders: only tracks with winnable trust AND a matching
  // contextKey ever reach the selectable track list.
  merged = merged.filter((t) => isSelectableTrack(t, ctx));

  if (doc && probe.ok && probe.tracks.length) {
    // Diagnostic-only cross-check, no extra requests: if the trusted
    // result and the untrusted probe disagree on languages, surface it.
    const trustedLans = new Set(merged.map((t) => t.lan));
    const legacyLans = new Set(probe.tracks.map((t) => t.lan));
    const overlap = [...legacyLans].some((l) => trustedLans.has(l));
    if (!overlap) {
      diag.add({
        resolver: 'cross-check',
        status: BS.diagnostics.SKIP,
        detail: 'legacy 探针与可信结果的轨道语言集合不一致（legacy 未采信，仅提示）'
      });
      BS.warn(runTag, 'legacy 探针与可信结果不一致（未采信，仅提示）');
    }
  }

  if (!doc) {
    const hints = buildHints(diag.steps, probe);
    const error = new Error(
      [`未能提取到字幕（run #${runId}）`, ...hints].filter(Boolean).join('\n')
    );
    error.hints = hints;
    diag.setDecision([`Decision · FAIL（run #${runId}）`]);
    return { ok: false, runId, error, ctx, tracks: merged, diag };
  }

  diag.setDecision([
    `Winner · ${winnerName} · trust ${doc.track.trust} · key ${doc.track.contextKey}`,
    `Ignored · legacy-json（${BS.trust.UNTRUSTED_LEGACY}：未签名接口不作为结果来源）`
  ]);
  BS.log(
    runTag,
    'winner',
    winnerName,
    doc.track.lanDoc || doc.track.lan,
    `${doc.cues.length} 条`,
    `trust ${doc.track.trust}`
  );

  return {
    ok: true,
    runId,
    ctx,
    track: doc.track,
    cues: doc.cues,
    tracks: merged,
    diag
  };
}

async function loadTrackBody(track, env) {
  const started = now();
  const cues = await env.net.getJson(track.url, { phase: 'body' }).then((d) => {
    const parsed = BS.parseSubtitleJson(d);
    if (!parsed.length) throw new Error('字幕内容为空');
    return parsed;
  });
  BS.log('轨道加载完成', track.lanDoc || track.lan, `${cues.length} 条`, `${now() - started}ms`);
  return cues;
}

BS.pipeline = { extract, loadTrackBody, isSelectableTrack };
