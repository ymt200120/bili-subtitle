/*
 * Exporters: plain text / timestamped text / SRT / JSON.
 */

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function fmtClock(sec, withMs = false) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);

  if (withMs) {
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function toPlainText(cues) {
  return cues.map((c) => c.content).join('\n');
}

function toTimestampedText(cues) {
  return cues.map((c) => `${fmtClock(c.from)}  ${c.content}`).join('\n');
}

function toSrt(cues) {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${fmtClock(c.from, true)} --> ${fmtClock(c.to, true)}\n${c.content}\n`
    )
    .join('\n');
}

function toJson(video, track, cues) {
  return JSON.stringify(
    {
      video: {
        bvid: video.bvid,
        aid: video.aid,
        cid: video.cid,
        page: video.page,
        title: video.title
      },
      track: {
        lan: track.lan,
        lanDoc: track.lanDoc,
        source: track.source
      },
      generator: `bili-subtitle ${BS.VERSION}`,
      body: cues.map((c) => ({ from: c.from, to: c.to, content: c.content }))
    },
    null,
    2
  );
}

function safeName(name) {
  return String(name || 'bilibili-subtitle')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

BS.exporters = { fmtClock, toPlainText, toTimestampedText, toSrt, toJson, safeName };
