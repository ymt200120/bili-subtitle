/*
 * Minimal UI: a "字幕" pill at the bottom-right and a small popover with
 * track list, export actions, preview and collapsed diagnostics.
 *
 * Dynamic content is set via textContent only (no HTML interpolation of
 * video titles or subtitle text). No settings page, no themes.
 */

const STYLE = `
#bs-pill {
  position: fixed; right: 20px; bottom: 84px; z-index: 2147483644;
  border: 0; border-radius: 999px; background: #fb7299; color: #fff;
  padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,.25); font-family: inherit;
}
#bs-panel {
  position: fixed; right: 20px; bottom: 130px; z-index: 2147483645;
  width: min(400px, calc(100vw - 40px)); max-height: min(70vh, 560px);
  overflow: auto; background: #fff; color: #18191c; border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0,0,0,.3); font-size: 13px; line-height: 1.6;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
#bs-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid #eee;
}
#bs-title { flex: 1; min-width: 0; font-weight: 700;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#bs-close { border: 0; background: transparent; font-size: 18px;
  cursor: pointer; color: #888; line-height: 1; }
#bs-status { padding: 6px 12px; color: #666; font-size: 12px; }
#bs-msg { margin: 0 12px 8px; padding: 8px 10px; border-radius: 8px;
  background: #fdeef0; color: #b2303f; white-space: pre-wrap; }
#bs-controls { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
#bs-count { padding: 0 12px 6px; color: #444; }
#bs-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
#bs-panel button, #bs-panel select {
  border: 1px solid #ddd; border-radius: 7px; background: #fff;
  padding: 5px 9px; cursor: pointer; color: #18191c; font-size: 12px; max-width: 100%;
}
#bs-panel button:hover { border-color: #fb7299; color: #fb7299; }
#bs-preview { margin: 0 12px 8px; padding: 8px 10px; background: #f7f8fa;
  border-radius: 8px; max-height: 180px; overflow: auto; white-space: pre-wrap;
  font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; }
#bs-asr { margin: 0 12px 8px; padding: 9px 10px; border: 1px dashed #fb7299;
  border-radius: 8px; background: #fff7f9; }
#bs-asr-note { color: #8a4b58; font-size: 12px; white-space: pre-wrap; }
#bs-asr-progress { margin-top: 6px; color: #b2303f; font-size: 12px; }
#bs-asr-bar { height: 4px; border-radius: 999px; background: #f3d6de;
  margin-top: 6px; overflow: hidden; }
#bs-asr-fill { height: 100%; width: 0; background: #fb7299;
  transition: width .2s linear; }
#bs-asr-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#bs-diag-box { margin: 0 12px 10px; }
#bs-diag-box summary { cursor: pointer; color: #888; font-size: 12px; }
#bs-diag { margin: 6px 0 0; padding: 8px 10px; background: #f7f8fa;
  border-radius: 8px; white-space: pre-wrap; font: 11px/1.7 ui-monospace, Menlo, Consolas, monospace; }
/* Player immersive modes (web fullscreen / native fullscreen): hide the
   floating UI completely — no invisible hitbox left over the controls. */
#bs-root.bs-player-fullscreen-hidden #bs-pill,
#bs-root.bs-player-fullscreen-hidden #bs-panel {
  display: none !important;
}
`;

const TEMPLATE = `
<div id="bs-panel" hidden>
  <div id="bs-head">
    <span id="bs-title">bili-subtitle</span>
    <button id="bs-close" title="关闭">×</button>
  </div>
  <div id="bs-status">就绪</div>
  <div id="bs-msg" hidden></div>
  <div id="bs-controls">
    <button id="bs-extract">提取字幕</button>
    <select id="bs-tracks" hidden></select>
  </div>
  <div id="bs-count" hidden></div>
  <div id="bs-asr" hidden>
    <div id="bs-asr-note"></div>
    <div id="bs-asr-progress" hidden></div>
    <div id="bs-asr-bar" hidden><div id="bs-asr-fill"></div></div>
    <div id="bs-asr-actions">
      <button id="bs-asr-run">语音识别生成字幕</button>
      <button id="bs-asr-cancel" hidden>取消</button>
    </div>
  </div>
  <div id="bs-actions" hidden>
    <button data-act="copy">复制文本</button>
    <button data-act="copy-ts">带时间轴</button>
    <button data-act="txt">TXT</button>
    <button data-act="srt">SRT</button>
    <button data-act="json">JSON</button>
  </div>
  <pre id="bs-preview" hidden></pre>
  <details id="bs-diag-box" hidden>
    <summary>获取路径</summary>
    <pre id="bs-diag"></pre>
  </details>
</div>
`;

function createPanel(handlers) {
  const root = document.createElement('div');
  root.id = 'bs-root';

  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);

  const pill = document.createElement('button');
  pill.id = 'bs-pill';
  pill.textContent = '字幕';
  root.appendChild(pill);

  root.insertAdjacentHTML('beforeend', TEMPLATE);
  document.body.appendChild(root);

  const $ = (id) => root.querySelector(`#${id}`);
  const panel = $('bs-panel');
  const title = $('bs-title');
  const status = $('bs-status');
  const msg = $('bs-msg');
  const extractBtn = $('bs-extract');
  const tracksSel = $('bs-tracks');
  const count = $('bs-count');
  const actions = $('bs-actions');
  const preview = $('bs-preview');
  const asrBox = $('bs-asr');
  const asrNote = $('bs-asr-note');
  const asrProgress = $('bs-asr-progress');
  const asrBar = $('bs-asr-bar');
  const asrFill = $('bs-asr-fill');
  const asrRun = $('bs-asr-run');
  const asrCancel = $('bs-asr-cancel');
  const diagBox = $('bs-diag-box');
  const diagPre = $('bs-diag');

  let trackKeyOf = () => '';

  function open() {
    panel.hidden = false;
  }

  function close() {
    panel.hidden = true;
  }

  pill.addEventListener('click', () => {
    if (panel.hidden) {
      open();
      if (handlers.onOpen) handlers.onOpen();
    } else {
      close();
    }
  });

  $('bs-close').addEventListener('click', close);
  extractBtn.addEventListener('click', () => handlers.onExtract());
  asrRun.addEventListener('click', () => {
    if (handlers.onAsr) handlers.onAsr();
  });
  asrCancel.addEventListener('click', () => {
    if (handlers.onAsrCancel) handlers.onAsrCancel();
  });

  tracksSel.addEventListener('change', () => {
    handlers.onTrackChange(tracksSel.value);
  });

  actions.addEventListener('click', (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (act) handlers.onExport(act);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  const api = {
    open,
    close,

    setTitle(text) {
      title.textContent = text || 'bili-subtitle';
    },

    setStatus(text) {
      status.textContent = text || '';
    },

    setMessage(text) {
      if (text) {
        msg.textContent = text;
        msg.hidden = false;
      } else {
        msg.hidden = true;
      }
    },

    setBusy(busy) {
      extractBtn.disabled = !!busy;
      extractBtn.textContent = busy ? '提取中…' : '提取字幕';
    },

    setTracks(tracks, selectedKey) {
      tracksSel.innerHTML = '';
      trackKeyOf = (t) => `${t.source}|${t.lan}|${t.url}`;
      for (const t of tracks) {
        const opt = document.createElement('option');
        opt.value = trackKeyOf(t);
        const label = t.lanDoc || t.lan || '字幕';
        opt.textContent =
          t.source === 'player-resource'
            ? `${label}（播放器捕获）`
            : t.source === 'asr'
              ? `${label}（语音识别）`
              : label;
        if (trackKeyOf(t) === selectedKey) opt.selected = true;
        tracksSel.appendChild(opt);
      }
      tracksSel.hidden = tracks.length < 2;
    },

    findTrack(tracks, key) {
      return tracks.find((t) => `${t.source}|${t.lan}|${t.url}` === key) || null;
    },

    setCues(cues, track) {
      const source = track.source === 'asr' ? '语音识别' : track.source;
      count.textContent = `${cues.length} 条 · ${track.lanDoc || track.lan || '字幕'} · 来源 ${source}`;
      count.hidden = false;
      actions.hidden = false;
      const head = cues
        .slice(0, 15)
        .map((c) => BS.exporters.fmtClock(c.from) + '  ' + c.content)
        .join('\n');
      preview.textContent =
        cues.length > 15 ? head + '\n…' : head;
      preview.hidden = false;
      msg.hidden = true;
    },

    /*
     * ASR offer / progress. Shown when the trusted chain found no subtitle
     * at all; the audio is downloaded and uploaded only after a click, so
     * the note spells out what that click does.
     */
    showAsr(durationSeconds) {
      const minutes = Math.max(1, Math.round((Number(durationSeconds) || 0) / 60));
      const size = ((Number(durationSeconds) || 0) * 8.25 / 1024).toFixed(1);
      asrNote.textContent =
        `此视频没有可用字幕（UP 主未开启 CC / AI 字幕）。\n` +
        `可用语音识别从音频生成：约 ${minutes} 分钟音频（约 ${size} MB），` +
        `上传至 B 站「必剪」语音识别接口，不经过第三方服务。`;
      asrBox.hidden = false;
      asrProgress.hidden = true;
      asrBar.hidden = true;
      asrFill.style.width = '0%';
      asrRun.hidden = false;
      asrRun.disabled = false;
      asrRun.textContent = '语音识别生成字幕';
      asrCancel.hidden = true;
    },

    hideAsr() {
      asrBox.hidden = true;
    },

    setAsrBusy(busy) {
      asrRun.disabled = !!busy;
      asrRun.textContent = busy ? '生成中…' : '语音识别生成字幕';
      asrCancel.hidden = !busy;
      asrRun.hidden = false;
    },

    setAsrProgress({ text, percent } = {}) {
      asrBox.hidden = false;
      if (text) {
        asrProgress.textContent = text;
        asrProgress.hidden = false;
      }
      if (typeof percent === 'number') {
        asrBar.hidden = false;
        asrFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      }
    },

    resetAsr() {
      asrBox.hidden = true;
      asrProgress.hidden = true;
      asrProgress.textContent = '';
      asrBar.hidden = true;
      asrFill.style.width = '0%';
      asrRun.disabled = false;
      asrRun.hidden = false;
      asrRun.textContent = '语音识别生成字幕';
      asrCancel.hidden = true;
    },

    setDiag(lines) {
      if (!lines || !lines.length) return;
      diagPre.textContent = lines.join('\n');
      diagBox.hidden = false;
    },

    clearResult() {
      count.hidden = true;
      actions.hidden = true;
      preview.hidden = true;
      msg.hidden = true;
      tracksSel.innerHTML = '';
      tracksSel.hidden = true;
      diagPre.textContent = '';
      diagBox.hidden = true;
      api.resetAsr();
    },

    /*
     * Player immersive mode (web fullscreen / native fullscreen).
     * Hides the whole floating UI via CSS (display:none — no hitbox);
     * closing the panel here is one-way: exiting fullscreen restores the
     * pill but never reopens the panel on its own.
     */
    setPlayerFullscreenHidden(hidden) {
      root.classList.toggle('bs-player-fullscreen-hidden', !!hidden);
      if (hidden) close();
    }
  };

  return api;
}

BS.ui = BS.ui || {};
BS.ui.createPanel = createPanel;
