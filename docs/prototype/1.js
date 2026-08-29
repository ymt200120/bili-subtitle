// ==UserScript==
// @name         B站字幕提取器（2026 修复版）
// @namespace    https://chatgpt.com/
// @version      1.0.0
// @description  提取 Bilibili 普通 CC / AI 字幕，支持复制、TXT/SRT/JSON 下载；AI 字幕支持从播放器网络请求中捕获。
// @author       ChatGPT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      subtitle.bilibili.com
// @connect      hdslb.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[B站字幕]';
  const captured = [];
  let lastHref = location.href;

  let current = {
    bvid: '',
    cid: 0,
    title: '',
    page: 1,
    body: [],
    source: '',
    lan: '',
    tracks: []
  };

  const log = (...args) =>
    console.log(
      `%c${TAG}`,
      'color:#fb7299;font-weight:bold',
      ...args
    );

  function rememberResource(url) {
    if (!url || typeof url !== 'string') return;

    if (
      !/aisubtitle\.hdslb\.com|subtitle\.bilibili\.com/i.test(url)
    ) {
      return;
    }

    if (captured.some(x => x.url === url)) return;

    captured.push({
      url,
      time: Date.now()
    });

    if (captured.length > 100) {
      captured.splice(0, captured.length - 100);
    }

    log('捕获字幕资源', url);
  }

  /*
   * 捕获播放器真正访问过的字幕资源。
   *
   * 这是 AI 字幕的关键兜底：
   * API 返回的字幕地址可能已经过期，但播放器当前实际请求的
   * aisubtitle.hdslb.com URL 往往仍然有效。
   */
  try {
    performance
      .getEntriesByType('resource')
      .forEach(e => rememberResource(e.name));

    const po = new PerformanceObserver(list => {
      list
        .getEntries()
        .forEach(e => rememberResource(e.name));
    });

    po.observe({
      type: 'resource',
      buffered: true
    });
  } catch (e) {
    log('PerformanceObserver 不可用', e);
  }

  function gmGet(url, timeout = 12000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout,
        anonymous: false,

        headers: {
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json,text/plain,*/*'
        },

        onload: r => {
          if (r.status >= 200 && r.status < 300) {
            resolve(r.responseText);
          } else {
            const err = new Error(
              `HTTP ${r.status}: ${url}`
            );

            err.status = r.status;
            err.url = url;
            err.responseText = r.responseText;

            reject(err);
          }
        },

        onerror: () =>
          reject(
            new Error(`网络错误: ${url}`)
          ),

        ontimeout: () =>
          reject(
            new Error(`请求超时: ${url}`)
          )
      });
    });
  }

  async function gmJson(url, timeout) {
    const text = await gmGet(url, timeout);

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        `返回内容不是 JSON: ${url}\n` +
        text.slice(0, 200)
      );
    }
  }

  function getBvid() {
    const m = location.pathname.match(
      /\b(BV[0-9A-Za-z]+)\b/i
    );

    return m ? m[1] : '';
  }

  function getP() {
    const n = Number(
      new URL(location.href).searchParams.get('p') || 1
    );

    return Number.isFinite(n) && n >= 1
      ? Math.floor(n)
      : 1;
  }

  /*
   * 获取 BV、cid、标题、分P。
   */
  async function resolveVideo() {
    const bvid = getBvid();

    if (!bvid) {
      throw new Error(
        '当前页面没有识别到 BV 号，请进入普通 B 站视频播放页。'
      );
    }

    const api =
      'https://api.bilibili.com/x/web-interface/view' +
      `?bvid=${encodeURIComponent(bvid)}`;

    const d = await gmJson(api);

    if (d.code !== 0 || !d.data) {
      throw new Error(
        `获取视频信息失败：${d.message || d.code}`
      );
    }

    const p = getP();

    const pages = Array.isArray(d.data.pages)
      ? d.data.pages
      : [];

    const selected =
      pages.find(x => Number(x.page) === p) ||
      pages[p - 1] ||
      pages[0];

    const cid = Number(
      selected?.cid ||
      d.data.cid ||
      0
    );

    if (!cid) {
      throw new Error('没有获取到 cid。');
    }

    current.bvid = bvid;
    current.cid = cid;
    current.page = Number(
      selected?.page || p || 1
    );

    current.title =
      selected?.part && pages.length > 1
        ? `${d.data.title} - P${current.page} ${selected.part}`
        : d.data.title ||
          document.title.replace(
            /_哔哩哔哩.*/,
            ''
          );

    return current;
  }

  function normalizeSubtitleUrl(url) {
    if (!url) return '';

    if (url.startsWith('//')) {
      return 'https:' + url;
    }

    if (url.startsWith('http://')) {
      return 'https://' + url.slice(7);
    }

    return url;
  }

  /*
   * 默认优先中文。
   */
  function languageScore(track) {
    const lan =
      String(track.lan || '').toLowerCase();

    const doc =
      String(track.lan_doc || '').toLowerCase();

    if (
      lan === 'zh-cn' ||
      lan === 'zh-hans' ||
      lan === 'zh'
    ) {
      return 100;
    }

    if (lan.includes('ai-zh')) {
      return 95;
    }

    if (
      doc.includes('中文') ||
      doc.includes('汉语')
    ) {
      return 90;
    }

    if (lan.startsWith('zh')) {
      return 85;
    }

    if (lan.startsWith('en')) {
      return 60;
    }

    return 10;
  }

  /*
   * B站播放器字幕列表 API。
   */
  async function getApiTracks() {
    const qs =
      `bvid=${encodeURIComponent(current.bvid)}` +
      `&cid=${encodeURIComponent(current.cid)}`;

    const d = await gmJson(
      `https://api.bilibili.com/x/player/v2?${qs}`
    );

    if (d.code !== 0) {
      throw new Error(
        `字幕列表接口失败：${d.message || d.code}`
      );
    }

    const subs =
      d?.data?.subtitle?.subtitles;

    if (!Array.isArray(subs)) {
      return [];
    }

    return subs
      .map((s, i) => ({
        id: String(s.id ?? i),
        lan: s.lan || '',
        lan_doc:
          s.lan_doc ||
          s.lan ||
          `字幕 ${i + 1}`,
        url: normalizeSubtitleUrl(
          s.subtitle_url || ''
        ),
        ai_type: s.ai_type,
        ai_status: s.ai_status,
        source: 'api'
      }))
      .filter(x => x.url)
      .sort(
        (a, b) =>
          languageScore(b) -
          languageScore(a)
      );
  }

  function parseSubtitleJson(d) {
    const body =
      Array.isArray(d?.body)
        ? d.body
        : [];

    return body
      .filter(
        x =>
          x &&
          typeof x.content === 'string'
      )
      .map(x => ({
        from: Number(x.from || 0),
        to: Number(
          x.to ||
          x.from ||
          0
        ),
        content: x.content
      }));
  }

  async function fetchTrack(track) {
    const d = await gmJson(
      track.url,
      15000
    );

    const body = parseSubtitleJson(d);

    if (!body.length) {
      throw new Error(
        `字幕 JSON 中没有 body：${track.url}`
      );
    }

    return body;
  }

  /*
   * 重新扫描浏览器 resource timing。
   */
  function scanCapturedUrls() {
    try {
      performance
        .getEntriesByType('resource')
        .forEach(e =>
          rememberResource(e.name)
        );
    } catch (_) {}

    const cidText =
      String(current.cid || '');

    return captured
      .slice()
      .sort(
        (a, b) =>
          b.time - a.time
      )
      .sort((a, b) => {
        const ac =
          cidText &&
          a.url.includes(cidText)
            ? 1
            : 0;

        const bc =
          cidText &&
          b.url.includes(cidText)
            ? 1
            : 0;

        return bc - ac;
      });
  }

  /*
   * 尝试播放器实际加载过的 AI 字幕 URL。
   */
  async function tryCapturedAi() {
    const urls =
      scanCapturedUrls();

    let lastErr = null;

    for (
      const item of urls.slice(0, 20)
    ) {
      try {
        const d = await gmJson(
          item.url,
          15000
        );

        const body =
          parseSubtitleJson(d);

        if (body.length) {
          return {
            body,

            track: {
              id: 'captured-ai',
              lan: 'ai',
              lan_doc:
                'AI 字幕（播放器捕获）',
              url: item.url,
              source: 'captured'
            }
          };
        }
      } catch (e) {
        lastErr = e;

        log(
          '捕获 URL 已失效，继续尝试下一条',
          e.message
        );
      }
    }

    if (lastErr) {
      log(
        '捕获字幕均无法读取',
        lastErr
      );
    }

    return null;
  }

  function fmtClock(
    sec,
    withMs = false
  ) {
    sec = Math.max(
      0,
      Number(sec) || 0
    );

    const h =
      Math.floor(sec / 3600);

    const m =
      Math.floor(
        (sec % 3600) / 60
      );

    const s =
      Math.floor(sec % 60);

    const ms =
      Math.round(
        (
          sec -
          Math.floor(sec)
        ) * 1000
      );

    const pad = (
      n,
      w = 2
    ) =>
      String(n).padStart(
        w,
        '0'
      );

    if (withMs) {
      return (
        `${pad(h)}:` +
        `${pad(m)}:` +
        `${pad(s)},` +
        `${pad(ms, 3)}`
      );
    }

    return h > 0
      ? `${pad(h)}:${pad(m)}:${pad(s)}`
      : `${pad(m)}:${pad(s)}`;
  }

  function toPlain(body) {
    return body
      .map(x => x.content)
      .join('\n');
  }

  function toTimestamped(body) {
    return body
      .map(
        x =>
          `${fmtClock(x.from)}  ${x.content}`
      )
      .join('\n');
  }

  function toSrt(body) {
    return body
      .map(
        (x, i) =>
          `${i + 1}\n` +
          `${fmtClock(x.from, true)} --> ` +
          `${fmtClock(x.to, true)}\n` +
          `${x.content}\n`
      )
      .join('\n');
  }

  function safeName(name) {
    return String(
      name ||
      'bilibili-subtitle'
    )
      .replace(
        /[\\/:*?"<>|]/g,
        '_'
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim()
      .slice(0, 100);
  }

  function downloadText(
    text,
    filename,
    type =
      'text/plain;charset=utf-8'
  ) {
    const blob =
      new Blob(
        [text],
        { type }
      );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement('a');

    a.href = url;
    a.download = filename;

    document.documentElement
      .appendChild(a);

    a.click();
    a.remove();

    setTimeout(
      () =>
        URL.revokeObjectURL(url),
      3000
    );
  }

  function copyText(text) {
    try {
      if (
        typeof GM_setClipboard ===
        'function'
      ) {
        GM_setClipboard(
          text,
          'text'
        );

        return Promise.resolve();
      }
    } catch (_) {}

    return navigator.clipboard
      .writeText(text);
  }

  function toast(
    msg,
    bad = false
  ) {
    let el =
      document.getElementById(
        'bili-sub-toast'
      );

    if (!el) {
      el =
        document.createElement(
          'div'
        );

      el.id =
        'bili-sub-toast';

      Object.assign(
        el.style,
        {
          position: 'fixed',
          left: '50%',
          bottom: '90px',
          transform:
            'translateX(-50%)',
          zIndex: '2147483647',
          padding: '9px 14px',
          borderRadius: '8px',
          color: '#fff',
          fontSize: '14px',
          boxShadow:
            '0 4px 18px rgba(0,0,0,.25)',
          transition:
            'opacity .2s'
        }
      );

      document.documentElement
        .appendChild(el);
    }

    el.style.background =
      bad
        ? '#d9485f'
        : '#333';

    el.style.opacity = '1';
    el.textContent = msg;

    clearTimeout(
      el._timer
    );

    el._timer =
      setTimeout(
        () => {
          el.style.opacity = '0';
        },
        1800
      );
  }

  function ensureUi() {
    if (
      !document.body ||
      document.getElementById(
        'bili-sub-fixed-btn'
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        'style'
      );

    style.textContent = `
#bili-sub-fixed-btn {
    position: fixed;
    right: 24px;
    bottom: 90px;
    z-index: 2147483645;
    border: 0;
    border-radius: 999px;
    background: #fb7299;
    color: #fff;
    padding: 11px 16px;
    font-size: 14px;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(0,0,0,.2);
    cursor: pointer;
}

#bili-sub-fixed-btn:hover {
    filter: brightness(.96);
}

#bili-sub-mask {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    background: rgba(0,0,0,.45);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

#bili-sub-panel {
    width: min(900px,94vw);
    height: min(720px,86vh);
    background: #fff;
    color: #18191c;
    border-radius: 14px;
    box-shadow: 0 18px 60px rgba(0,0,0,.35);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        "Microsoft YaHei",
        sans-serif;
}

#bili-sub-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid #eee;
}

#bili-sub-title {
    font-weight: 700;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

#bili-sub-close {
    border: 0;
    background: transparent;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    color: #666;
}

#bili-sub-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid #eee;
    align-items: center;
}

#bili-sub-toolbar button,
#bili-sub-toolbar select {
    border: 1px solid #ddd;
    background: #fff;
    border-radius: 7px;
    padding: 7px 10px;
    cursor: pointer;
    color: #18191c;
}

#bili-sub-toolbar button:hover {
    border-color: #fb7299;
    color: #fb7299;
}

#bili-sub-status {
    padding: 8px 16px;
    font-size: 13px;
    color: #666;
    background: #fafafa;
    border-bottom: 1px solid #eee;
    white-space: pre-wrap;
}

#bili-sub-text {
    flex: 1;
    margin: 0;
    padding: 16px;
    border: 0;
    outline: 0;
    resize: none;
    font:
        14px/1.75
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Consolas,
        "Liberation Mono",
        monospace;
    color: #222;
    background: #fff;
}

#bili-sub-help {
    padding: 14px 16px;
    line-height: 1.7;
    color: #444;
    overflow: auto;
}

#bili-sub-help b {
    color: #fb7299;
}
`;

    document.documentElement
      .appendChild(style);

    const btn =
      document.createElement(
        'button'
      );

    btn.id =
      'bili-sub-fixed-btn';

    btn.textContent =
      '提取字幕';

    btn.addEventListener(
      'click',
      () => extract(false)
    );

    document.body
      .appendChild(btn);

    const mask =
      document.createElement(
        'div'
      );

    mask.id =
      'bili-sub-mask';

    mask.innerHTML = `
<div id="bili-sub-panel">

    <div id="bili-sub-head">
        <div id="bili-sub-title">
            B站字幕提取器
        </div>

        <button
            id="bili-sub-close"
            title="关闭"
        >
            ×
        </button>
    </div>

    <div id="bili-sub-toolbar">

        <select
            id="bili-sub-lang"
            title="字幕语言"
        ></select>

        <button data-act="retry">
            重新提取
        </button>

        <button data-act="copy">
            复制纯文本
        </button>

        <button data-act="copy-ts">
            复制带时间轴
        </button>

        <button data-act="txt">
            下载 TXT
        </button>

        <button data-act="srt">
            下载 SRT
        </button>

        <button data-act="json">
            下载 JSON
        </button>

    </div>

    <div id="bili-sub-status">
        就绪
    </div>

    <textarea
        id="bili-sub-text"
        spellcheck="false"
        readonly
    ></textarea>

    <div
        id="bili-sub-help"
        style="display:none"
    ></div>

</div>
`;

    document.body
      .appendChild(mask);

    mask.addEventListener(
      'click',
      e => {
        if (e.target === mask) {
          closePanel();
        }
      }
    );

    mask
      .querySelector(
        '#bili-sub-close'
      )
      .addEventListener(
        'click',
        closePanel
      );

    mask
      .querySelector(
        '#bili-sub-lang'
      )
      .addEventListener(
        'change',
        async e => {
          const t =
            current.tracks.find(
              x =>
                x.id ===
                e.target.value
            );

          if (!t) return;

          setStatus(
            `正在读取：${t.lan_doc}…`
          );

          try {
            const body =
              await fetchTrack(t);

            showBody(
              body,
              t
            );
          } catch (err) {
            showError(
              err,
              true
            );
          }
        }
      );

    mask
      .querySelector(
        '#bili-sub-toolbar'
      )
      .addEventListener(
        'click',
        async e => {
          const act =
            e.target?.dataset?.act;

          if (!act) return;

          if (
            act === 'retry'
          ) {
            return extract(true);
          }

          if (
            !current.body.length
          ) {
            return toast(
              '当前还没有字幕',
              true
            );
          }

          const base =
            safeName(
              current.title
            );

          if (
            act === 'copy'
          ) {
            await copyText(
              toPlain(
                current.body
              )
            );

            toast(
              '已复制纯文本'
            );
          }

          if (
            act === 'copy-ts'
          ) {
            await copyText(
              toTimestamped(
                current.body
              )
            );

            toast(
              '已复制带时间轴文本'
            );
          }

          if (
            act === 'txt'
          ) {
            downloadText(
              toTimestamped(
                current.body
              ),
              `${base}.txt`
            );
          }

          if (
            act === 'srt'
          ) {
            downloadText(
              toSrt(
                current.body
              ),
              `${base}.srt`,
              'application/x-subrip;charset=utf-8'
            );
          }

          if (
            act === 'json'
          ) {
            downloadText(
              JSON.stringify(
                {
                  body:
                    current.body
                },
                null,
                2
              ),
              `${base}.json`,
              'application/json;charset=utf-8'
            );
          }
        }
      );
  }

  function openPanel() {
    const m =
      document.getElementById(
        'bili-sub-mask'
      );

    if (m) {
      m.style.display =
        'flex';
    }
  }

  function closePanel() {
    const m =
      document.getElementById(
        'bili-sub-mask'
      );

    if (m) {
      m.style.display =
        'none';
    }
  }

  function setStatus(text) {
    openPanel();

    const s =
      document.getElementById(
        'bili-sub-status'
      );

    if (s) {
      s.textContent = text;
    }
  }

  function showBody(
    body,
    track
  ) {
    current.body = body;
    current.source =
      track.source;
    current.lan =
      track.lan;

    document.getElementById(
      'bili-sub-title'
    ).textContent =
      current.title ||
      'B站字幕';

    document.getElementById(
      'bili-sub-text'
    ).style.display =
      'block';

    document.getElementById(
      'bili-sub-help'
    ).style.display =
      'none';

    document.getElementById(
      'bili-sub-text'
    ).value =
      toTimestamped(body);

    setStatus(
      `成功：${
        track.lan_doc ||
        track.lan ||
        '字幕'
      } · ${body.length} 条 · 来源：${
        track.source ===
        'captured'
          ? '播放器网络捕获'
          : 'B站字幕 API'
      }`
    );

    renderTrackSelect(
      track.id
    );
  }

  function renderTrackSelect(
    selectedId
  ) {
    const sel =
      document.getElementById(
        'bili-sub-lang'
      );

    if (!sel) return;

    sel.innerHTML = '';

    const list =
      current.tracks.length
        ? current.tracks
        : [
            {
              id:
                selectedId,
              lan_doc:
                'AI 字幕（播放器捕获）'
            }
          ];

    list.forEach(t => {
      const o =
        document.createElement(
          'option'
        );

      o.value = t.id;

      o.textContent =
        t.lan_doc ||
        t.lan ||
        '字幕';

      o.selected =
        t.id === selectedId;

      sel.appendChild(o);
    });
  }

  function showAiHelp(
    extra = ''
  ) {
    current.body = [];

    document.getElementById(
      'bili-sub-text'
    ).style.display =
      'none';

    const h =
      document.getElementById(
        'bili-sub-help'
      );

    h.style.display =
      'block';

    h.innerHTML = `
<b>这个视频很可能只有 AI 字幕。</b>

<br><br>

1. 确保你已经登录 B 站。<br>
2. 在当前播放器里打开「字幕 / CC」，选择「中文（自动生成）」或 AI 字幕。<br>
3. <b>不要刷新页面。</b>看到字幕出现后，点上面的「重新提取」。

<br><br>

脚本会直接读取播放器刚刚请求的
<code>aisubtitle.hdslb.com</code>
地址，不再依赖已经失效的旧 URL。

${
  extra
    ? `
<br><br>
<span style="color:#999">
诊断：${escapeHtml(extra)}
</span>`
    : ''
}
`;

    setStatus(
      'API 没有可用字幕；等待播放器生成/加载 AI 字幕。'
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(
        /[&<>"']/g,
        c =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
          })[c]
      );
  }

  function showError(
    err,
    allowAiHelp = false
  ) {
    console.error(
      TAG,
      err
    );

    if (
      allowAiHelp &&
      (
        err?.status === 404 ||
        /404|subtitle|字幕/i.test(
          err?.message ||
          ''
        )
      )
    ) {
      showAiHelp(
        err.message
      );

      return;
    }

    current.body = [];

    document.getElementById(
      'bili-sub-text'
    ).style.display =
      'none';

    const h =
      document.getElementById(
        'bili-sub-help'
      );

    h.style.display =
      'block';

    h.innerHTML = `
<b>提取失败</b>

<br><br>

<pre style="white-space:pre-wrap">${
  escapeHtml(
    err?.stack ||
    err?.message ||
    String(err)
  )
}</pre>
`;

    setStatus(
      '提取失败；详细错误已经写入 F12 Console。'
    );
  }

  async function extract(
    forceCapturedFirst
  ) {
    ensureUi();
    openPanel();

    current.body = [];
    current.tracks = [];

    document.getElementById(
      'bili-sub-help'
    ).style.display =
      'none';

    document.getElementById(
      'bili-sub-text'
    ).style.display =
      'block';

    document.getElementById(
      'bili-sub-text'
    ).value = '';

    try {
      setStatus(
        '正在识别视频和分P…'
      );

      await resolveVideo();

      document.getElementById(
        'bili-sub-title'
      ).textContent =
        current.title;

      /*
       * 用户点击“重新提取”时，
       * 优先找刚才播放器加载出的 AI 字幕。
       */
      if (
        forceCapturedFirst
      ) {
        setStatus(
          '正在检查播放器刚刚加载的 AI 字幕…'
        );

        const cap =
          await tryCapturedAi();

        if (cap) {
          current.tracks = [
            cap.track
          ];

          showBody(
            cap.body,
            cap.track
          );

          return;
        }
      }

      setStatus(
        '正在查询 B 站字幕列表…'
      );

      let tracks = [];
      let apiErr = null;

      try {
        tracks =
          await getApiTracks();
      } catch (e) {
        apiErr = e;

        log(
          '字幕列表 API 失败',
          e
        );
      }

      current.tracks =
        tracks;

      /*
       * API 返回了字幕。
       */
      if (tracks.length) {
        let firstErr = null;

        for (
          const track of tracks
        ) {
          setStatus(
            `正在读取：${track.lan_doc}…`
          );

          try {
            const body =
              await fetchTrack(
                track
              );

            showBody(
              body,
              track
            );

            return;

          } catch (e) {
            firstErr ||= e;

            log(
              'API 返回的字幕 URL 无法读取',
              track.url,
              e
            );
          }
        }

        /*
         * API 有字幕，但链接已经 404 / 过期。
         * 尝试播放器实际加载的地址。
         */
        setStatus(
          'API 字幕地址不可用，正在查找播放器实际使用的 AI 字幕地址…'
        );

        const cap =
          await tryCapturedAi();

        if (cap) {
          current.tracks = [
            cap.track,
            ...tracks
          ];

          showBody(
            cap.body,
            cap.track
          );

          return;
        }

        showAiHelp(
          firstErr?.message ||
          'API 中的字幕地址均不可用'
        );

        return;
      }

      /*
       * API 根本没有字幕。
       */
      setStatus(
        'API 没有返回字幕，正在查找播放器已加载的 AI 字幕…'
      );

      const cap =
        await tryCapturedAi();

      if (cap) {
        current.tracks = [
          cap.track
        ];

        showBody(
          cap.body,
          cap.track
        );

        return;
      }

      showAiHelp(
        apiErr?.message ||
        '当前字幕列表为空'
      );

    } catch (err) {
      showError(
        err,
        true
      );
    }
  }

  function boot() {
    /*
     * 页面加载出来以后插入按钮。
     */
    const timer =
      setInterval(() => {
        if (
          document.body
        ) {
          ensureUi();
          clearInterval(
            timer
          );
        }
      }, 250);

    /*
     * B站使用 SPA。
     * 换视频后清理当前视频状态。
     *
     * 但不立刻清空 captured，
     * 因为播放器捕获结果可能仍用于兜底。
     */
    setInterval(() => {
      if (
        location.href !==
        lastHref
      ) {
        lastHref =
          location.href;

        current = {
          bvid: '',
          cid: 0,
          title: '',
          page: 1,
          body: [],
          source: '',
          lan: '',
          tracks: []
        };
      }
    }, 500);

    document.addEventListener(
      'keydown',
      e => {
        if (
          e.key === 'Escape'
        ) {
          closePanel();
        }
      }
    );
  }

  boot();

})();