#!/usr/bin/env node
/*
 * Manual, network-only check of the ASR fallback (NOT part of `npm test`).
 *
 *   node scripts/asr-live.mjs BV1aVs267E8Z
 *
 * It resolves the video context, then runs the same src/ code the userscript
 * bundles: signed playurl -> DASH audio -> Bcut ASR -> cues. Serve as an
 * end-to-end reference for docs/PROTOCOL.md §8; requires network access.
 */

import { loadSrc } from '../tests/load.mjs';

const bvid = process.argv[2];
if (!bvid) {
  console.error('usage: node scripts/asr-live.mjs <BVid>');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const realFetch = globalThis.fetch;
const browserishFetch = (url, init = {}) =>
  realFetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      ...(init.headers || {})
    }
  });

const BS = loadSrc({
  fetch: browserishFetch,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout
});

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

const view = await BS.net.getJson(
  `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  { phase: 'view' }
);
if (view.code !== 0) {
  console.error(`view API failed: ${view.code} ${view.message}`);
  process.exit(1);
}
const video = view.data;
const ctx = BS.makeVideoContext({
  bvid: video.bvid,
  aid: video.aid,
  cid: video.cid,
  page: 1,
  pageCount: video.pages ? video.pages.length : 1,
  title: video.title,
  duration: video.duration
});

console.log(`[${elapsed()}s] ${ctx.bvid} · aid ${ctx.aid} · cid ${ctx.cid} · ${ctx.duration}s · ${ctx.title}`);

let lastText = '';
const result = await BS.asr.generate(ctx, { net: BS.net }, {
  onProgress: ({ text, percent }) => {
    if (text === lastText) return;
    lastText = text;
    console.log(`[${elapsed()}s] ${percent}% ${text}`);
  }
});

console.log('---');
console.log(
  `track ${result.track.lan} / ${result.track.source} / ${result.track.trust} · ` +
    `${result.cues.length} cues · audio ${(result.audio.bytes / 1048576).toFixed(1)} MB (id ${result.audio.id})`
);
console.log('selectable:', BS.pipeline.isSelectableTrack(result.track, ctx));
console.log('first 5 cues:');
for (const cue of result.cues.slice(0, 5)) {
  console.log(`  ${cue.from.toFixed(2)}-${cue.to.toFixed(2)}  ${cue.content}`);
}
console.log('SRT head:');
console.log(BS.exporters.toSrt(result.cues.slice(0, 3)));
console.log(`total ${elapsed()}s`);
