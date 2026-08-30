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
#bs-diag-box { margin: 0 12px 10px; }
#bs-diag-box summary { cursor: pointer; color: #888; font-size: 12px; }
#bs-diag { margin: 6px 0 0; padding: 8px 10px; background: #f7f8fa;
  border-radius: 8px; white-space: pre-wrap; font: 11px/1.7 ui-monospace, Menlo, Consolas, monospace; }
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
      count.textContent = `${cues.length} 条 · ${track.lanDoc || track.lan || '字幕'} · 来源 ${track.source}`;
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
    }
  };

  return api;
}

BS.ui = { createPanel };
