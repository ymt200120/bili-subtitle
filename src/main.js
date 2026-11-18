/*
 * Entry point: state, UI wiring, export actions, SPA reset.
 */

function createAppState() {
  // gen: monotonic token. Every user action that starts an async flow
  // (extract, track load) or invalidates one (SPA navigation) bumps it;
  // a flow whose gen is no longer current must not touch state or panel.
  return { ctx: null, tracks: [], track: null, cues: [], gen: 0, asrRunning: false, asrCancel: false };
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
    // No subtitle exists for this video (uploader did not enable CC/AI):
    // offer the ASR fallback instead of a dead end.
    if (result.ctx) panel.showAsr(result.ctx.duration);
    BS.errorLog('提取失败');
    for (const line of result.diag.render()) BS.errorLog(line);
    return;
  }

  state.track = result.track;
  state.cues = result.cues;
  panel.setMessage('');
  panel.hideAsr();
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
  if (state.asrRunning) {
    panel.setStatus('语音识别进行中，请先取消或等待完成');
    return;
  }
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

  // ASR tracks carry their cues inline (no subtitle URL to fetch).
  if (Array.isArray(track.cues) && track.cues.length) {
    if (!identityMatches(state.ctx)) {
      panel.setStatus('页面视频已变化，请重新提取');
      return;
    }
    state.track = track;
    state.cues = track.cues;
    panel.setCues(track.cues, track);
    panel.setStatus('提取成功');
    return;
  }

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

/*
 * ASR fallback: no subtitle exists, so transcribe the video's audio.
 * Explicit user action only — audio is downloaded and uploaded to
 * Bilibili's own Bcut ASR service, never to a third party.
 */
async function onAsr(state, panel) {
  const ctx = state.ctx;
  if (!ctx) {
    panel.setStatus('请先点「提取字幕」确认当前视频');
    return;
  }
  if (state.asrRunning) return;
  if (state.extracting) {
    panel.setStatus('提取进行中，请稍候');
    return;
  }

  const gen = ++state.gen;
  state.asrRunning = true;
  state.asrCancel = false;
  const stale = () => gen !== state.gen || state.asrCancel;

  const steps = [];
  const addStep = (mark, name, detail) => {
    steps.push(`${mark} ${name}${detail ? ' · ' + detail : ''}`);
    panel.setDiag(['语音识别（必剪）', ...steps]);
  };
  let pollLogged = false;

  panel.setMessage('');
  panel.setAsrBusy(true);
  panel.setAsrProgress({ text: '准备…', percent: 1 });
  panel.setStatus('语音识别中…');

  try {
    const result = await BS.asr.generate(ctx, makeEnv(state, panel, stale), {
      isCancelled: stale,
      onProgress: (p) => {
        if (!stale()) panel.setAsrProgress(p);
      },
      onStage: (name, info) => {
        if (stale()) return;
        if (name === 'stream') {
          addStep('✓', '音频流', `id ${info.id} · ${Math.round(info.bandwidth / 1000)} kbps`);
        } else if (name === 'download') {
          addStep('✓', '下载音频', `${(info.bytes / 1048576).toFixed(1)} MB`);
        } else if (name === 'poll' && !pollLogged) {
          pollLogged = true;
          addStep('…', '识别中', '等待必剪返回结果');
        }
      }
    });

    if (stale()) return;
    if (!identityMatches(ctx)) {
      panel.setStatus('页面视频已变化，请重新识别');
      return;
    }

    state.tracks = [result.track];
    state.track = result.track;
    state.cues = result.cues;
    panel.setTracks(
      state.tracks,
      `${result.track.source}|${result.track.lan}|${result.track.url}`
    );
    panel.setCues(result.cues, result.track);
    panel.hideAsr();
    addStep('✓', '识别完成', `${result.utterances} 句 → ${result.cues.length} 条字幕`);
    panel.setStatus(`语音识别完成（${result.cues.length} 条）`);
    BS.log(
      '语音识别完成',
      `${result.cues.length} 条`,
      `${(result.audio.bytes / 1048576).toFixed(1)} MB`,
      `音频流 ${result.audio.id}`
    );
  } catch (e) {
    const cancelled = state.asrCancel;
    if (cancelled || stale()) {
      if (cancelled) {
        addStep('○', '语音识别', '已取消');
        panel.setStatus('已取消语音识别');
        panel.setAsrProgress({ text: '已取消' });
        state.asrRunning = false;
        panel.setAsrBusy(false);
      }
      return;
    }
    panel.setStatus('语音识别失败');
    panel.setMessage(e && e.message ? e.message : String(e));
    addStep('✗', '语音识别', e && e.message ? e.message : String(e));
    BS.errorLog('语音识别失败', e);
  } finally {
    if (!stale()) {
      state.asrRunning = false;
      panel.setAsrBusy(false);
    }
  }
}

function onAsrCancel(state, panel) {
  if (!state.asrRunning) return;
  state.asrCancel = true;
  panel.setStatus('正在取消…');
  panel.setAsrProgress({ text: '正在取消…' });
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
      if (!state.cues.length && !state.extracting && !state.asrRunning) {
        onExtract(state, panel);
      }
    },
    onExtract: () => onExtract(state, panel),
    onTrackChange: (key) => onTrackChange(state, panel, key),
    onExport: (act) => onExport(state, panel, act),
    onAsr: () => onAsr(state, panel),
    onAsrCancel: () => onAsrCancel(state, panel)
  });

  BS.resourceCapture.install();

  // Hide the floating UI in Bilibili's immersive player modes (web
  // fullscreen / native fullscreen); state-driven, see display-mode.js.
  const displayModeWatcher = BS.ui.displayMode.watchPlayerScreenMode(({ hidden }) => {
    panel.setPlayerFullscreenHidden(hidden);
  });

  BS.installSpaHooks(() => {
    // Invalidate any in-flight extract / track load for the previous
    // video; their results must never land on the new video's panel.
    state.gen++;
    BS.resourceCapture.reset();
    displayModeWatcher.rebind();
    state.extracting = false;
    state.asrRunning = false;
    state.asrCancel = false;
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
