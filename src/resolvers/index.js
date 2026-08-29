/*
 * Subtitle resolver pipeline.
 *
 * Strategies run in order (legacy JSON -> protobuf web view -> player
 * resource capture). Each strategy discovers tracks and tries to load a
 * body; the first success wins. Signed subtitle URLs are never cached:
 * a 403/404 body fetch triggers one extra discovery round with fresh
 * metadata. Every attempt is recorded as a diagnostics step.
 *
 * env = { net, href, initialState, getEntries, onUpdate, onContext }
 * (all injectable so the whole pipeline runs under node:test with mocks)
 */

const EXPIRY_STATUS = [403, 404];

function isExpiryError(err) {
  return err && EXPIRY_STATUS.includes(err.status);
}

function now() {
  return Date.now();
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

function buildHints(diagSteps) {
  const okNote = (name) =>
    diagSteps.some(
      (s) =>
        s.resolver === name &&
        s.status === BS.diagnostics.OK &&
        s.detail &&
        !/条/.test(s.detail)
    );

  const notes = [];
  if (okNote('legacy-json') && okNote('web-view')) {
    notes.push('两个字幕接口都返回空轨道：AI 字幕通常需要登录 B 站后才能获取。');
  }
  notes.push('兜底提示：在播放器中打开「字幕 / CC」并选择 AI 字幕，让播放器实际加载一次，再点「重新提取」。');
  return notes;
}

async function extract(env) {
  const diag = BS.diagnostics.createDiagnostics();
  const tried = new Set();
  env.onUpdate && env.onUpdate('正在识别视频…');

  let ctx;
  try {
    ctx = await BS.resolvers.videoContext.resolve(env);
  } catch (e) {
    diag.add({
      resolver: 'video-context',
      status: BS.diagnostics.FAIL,
      detail: e.message
    });
    return { ok: false, error: e, tracks: [], diag };
  }
  diag.add({
    resolver: 'video-context',
    status: BS.diagnostics.OK,
    detail: `${ctx.bvid} · cid ${ctx.cid} · P${ctx.page}`
  });
  env.onContext && env.onContext(ctx);

  const strategies = [
    BS.resolvers.legacy,
    BS.resolvers.webView,
    BS.resolvers.playerResource
  ];

  let merged = [];
  let doc = null;
  let retryable = false;

  for (const strategy of strategies) {
    env.onUpdate && env.onUpdate(`正在尝试：${strategy.name}`);
    const r = await runStrategy(strategy, ctx, env, diag, tried);
    merged = BS.mergeTracks([merged, r.tracks]);
    if (r.doc) {
      doc = r.doc;
      break;
    }
    if (r.retryable) retryable = true;
  }

  if (!doc && retryable) {
    env.onUpdate && env.onUpdate('字幕地址已过期，正在重新获取…');
    for (const strategy of [BS.resolvers.legacy, BS.resolvers.webView]) {
      const r = await runStrategy(strategy, ctx, env, diag, tried);
      merged = BS.mergeTracks([merged, r.tracks]);
      if (r.doc) {
        doc = r.doc;
        break;
      }
    }
  }

  if (!doc) {
    const hints = buildHints(diag.steps);
    const error = new Error(
      ['未能提取到字幕', ...hints].filter(Boolean).join('\n')
    );
    error.hints = hints;
    return { ok: false, error, ctx, tracks: merged, diag };
  }

  return { ok: true, ctx, track: doc.track, cues: doc.cues, tracks: merged, diag };
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

BS.pipeline = { extract, loadTrackBody };
