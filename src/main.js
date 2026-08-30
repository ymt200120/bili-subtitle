/*
 * Entry point: state, UI wiring, export actions, SPA reset.
 */

function createAppState() {
  // gen: monotonic token. Every user action that starts an async flow
  // (extract, track load) or invalidates one (SPA navigation) bumps it;
  // a flow whose gen is no longer current must not touch state or panel.
  return { ctx: null, tracks: [], track: null, cues: [], gen: 0 };
}

function makeEnv(state, panel, isStale) {
  return {
    net: BS.net,
    href: location.href,
    initialState: typeof window.__INITIAL_STATE__ !== 'undefined'
      ? window.__INITIAL_STATE__
      : null,
    getEntries: () => BS.resourceCapture.list(),
    onUpdate: (text) => {
      if (!isStale || !isStale()) panel.setStatus(text);
    },
    onContext: (ctx) => {
      if (!isStale || !isStale()) panel.setTitle(ctx.title || ctx.bvid);
    }
  };
}

function copyText(text) {
  if (typeof GM_setClipboard === 'function') {
    GM_setClipboard(text, 'text');
    return Promise.resolve();
  }
  return navigator.clipboard.writeText(text);
}

function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function baseName(state) {
  return BS.exporters.safeName(
    (state.ctx && state.ctx.title) || state.ctx.bvid || 'bilibili-subtitle'
  );
}

/*
 * Current video identity straight from the URL. Used as a commit-time
 * guard: even if the generation token is still current (e.g. a missed
 * SPA hook), a result computed for a different bvid/page must not land.
 */
function currentVideoIdentity() {
  const parsed = BS.parseVideoUrl(location.href);
  return parsed ? { bvid: parsed.bvid, page: parsed.page || 1 } : null;
}

function identityMatches(ctx) {
  const fresh = currentVideoIdentity();
  return Boolean(fresh && ctx && fresh.bvid === ctx.bvid && fresh.page === ctx.page);
}

function applyResult(state, panel, result) {
  state.tracks = result.tracks || [];
  panel.setDiag(result.diag.render());

  if (!result.ok) {
    state.track = null;
    state.cues = [];
    panel.setMessage(result.error.message);
    panel.setStatus('提取失败，详见「获取路径」');
    BS.errorLog('提取失败');
    for (const line of result.diag.render()) BS.errorLog(line);
    return;
  }

  state.track = result.track;
  state.cues = result.cues;
  panel.setMessage('');
  panel.setTracks(state.tracks, `${result.track.source}|${result.track.lan}|${result.track.url}`);
  panel.setCues(result.cues, result.track);
  panel.setStatus('提取成功');
  BS.log(
    '提取成功',
    result.track.lanDoc || result.track.lan,
    `${result.cues.length} 条`,
    `来源 ${result.track.source}`
  );
}

async function onExtract(state, panel) {
  if (state.extracting) return;
  const gen = ++state.gen;
  state.extracting = true;
  panel.setBusy(true);
  panel.clearResult();
  panel.setMessage('');

  const stale = () => gen !== state.gen;
  try {
    const result = await BS.pipeline.extract(makeEnv(state, panel, stale));
    if (stale()) {
      BS.log(`[run:${result && result.runId}]`, '提取结果已过期（视频已切换），丢弃');
      return;
    }
    // Commit needs BOTH conditions: current generation AND the page still
    // being the video this result belongs to.
    if (!identityMatches(result.ctx)) {
      BS.log(`[run:${result.runId}]`, '结果与当前页面视频不一致，丢弃');
      panel.setStatus('页面视频已变化，请重新提取');
      return;
    }
    state.ctx = result.ctx || state.ctx;
    applyResult(state, panel, result);
    if (result.runId) panel.setStatus(`提取成功（run #${result.runId}）`);
  } catch (e) {
    if (stale()) {
      BS.log('提取错误已过期（视频已切换），丢弃');
      return;
    }
    panel.setMessage(e && e.message ? e.message : String(e));
    panel.setStatus('提取失败');
    BS.errorLog('未预期的错误', e);
  } finally {
    // A superseded run must not clear the busy flag of the run that owns
    // the current gen (the SPA hook already reset the flag when it bumped gen).
    if (!stale()) {
      state.extracting = false;
      panel.setBusy(false);
    }
  }
}

async function onTrackChange(state, panel, key) {
  const track = panel.findTrack(state.tracks, key);
  if (!track) return;
  // Fail closed: only a track provably bound to the current video context
  // may be loaded.
  if (!BS.pipeline.isSelectableTrack(track, state.ctx)) {
    panel.setStatus('该轨道与当前视频不匹配，已拒绝');
    panel.setMessage('轨道归属校验失败，请点「提取字幕」重新获取。');
    BS.warn('track change 拒绝：trust/contextKey 校验未通过', BS.sanitizeUrl(track.url));
    return;
  }
  const gen = ++state.gen;
  const stale = () => gen !== state.gen;
  panel.setStatus(`正在读取：${track.lanDoc || track.lan}…`);
  try {
    const cues = await BS.pipeline.loadTrackBody(track, makeEnv(state, panel, stale));
    if (stale()) {
      BS.log('轨道结果已过期，丢弃');
      return;
    }
    if (!identityMatches(state.ctx)) {
      BS.log('轨道结果与当前页面视频不一致，丢弃');
      panel.setStatus('页面视频已变化，请重新提取');
      return;
    }
    state.track = track;
    state.cues = cues;
    panel.setCues(cues, track);
    panel.setStatus('提取成功');
  } catch (e) {
    if (stale()) return;
    panel.setStatus('轨道读取失败');
    panel.setMessage(
      (e && e.status === 403) || (e && e.status === 404)
        ? '该字幕地址已过期，请点「提取字幕」重新获取。'
        : (e && e.message) || String(e)
    );
    BS.warn('轨道读取失败', BS.sanitizeUrl(track.url), e && e.message);
  }
}

function onExport(state, panel, act) {
  if (!state.cues || !state.cues.length || !state.track) {
    panel.setStatus('当前没有字幕，请先提取');
    return;
  }
  const { cues, track, ctx } = state;
  const base = baseName(state);
  const done = (what) => panel.setStatus(`${what}完成`);

  switch (act) {
    case 'copy':
      copyText(BS.exporters.toPlainText(cues)).then(
        () => done('复制'),
        () => panel.setStatus('复制失败')
      );
      break;
    case 'copy-ts':
      copyText(BS.exporters.toTimestampedText(cues)).then(
        () => done('复制'),
        () => panel.setStatus('复制失败')
      );
      break;
    case 'txt':
      downloadText(BS.exporters.toTimestampedText(cues), `${base}.txt`);
      done('TXT 下载');
      break;
    case 'srt':
      downloadText(
        BS.exporters.toSrt(cues),
        `${base}.srt`,
        'application/x-subrip;charset=utf-8'
      );
      done('SRT 下载');
      break;
    case 'json':
      downloadText(
        BS.exporters.toJson(ctx, track, cues),
        `${base}.json`,
        'application/json;charset=utf-8'
      );
      done('JSON 下载');
      break;
  }
}

function boot() {
  if (!document.body) return false;

  const state = createAppState();
  const panel = BS.ui.createPanel({
    onOpen: () => {
      if (!state.cues.length && !state.extracting) onExtract(state, panel);
    },
    onExtract: () => onExtract(state, panel),
    onTrackChange: (key) => onTrackChange(state, panel, key),
    onExport: (act) => onExport(state, panel, act)
  });

  BS.resourceCapture.install();

  BS.installSpaHooks(() => {
    // Invalidate any in-flight extract / track load for the previous
    // video; their results must never land on the new video's panel.
    state.gen++;
    BS.resourceCapture.reset();
    state.extracting = false;
    panel.setBusy(false);
    state.ctx = null;
    state.tracks = [];
    state.track = null;
    state.cues = [];
    panel.clearResult();
    panel.setTitle('bili-subtitle');
    panel.setStatus('已切换视频，点击「提取字幕」');
    BS.log('SPA 导航：状态已重置');
  });

  BS.log(`v${BS.VERSION} 已加载`);
  return true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
