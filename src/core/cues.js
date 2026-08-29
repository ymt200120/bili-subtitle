/*
 * Subtitle body parsing and cue normalization.
 *
 * Bilibili subtitle JSON: { "body": [ { "from": 0.0, "to": 1.2, "content": "..." } ] }
 * Long AI tracks can arrive segmented; sort and drop exact duplicates.
 */

function parseCue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) return null;
  const from = Number(raw.from);
  const to = Number(raw.to);
  return {
    from: Number.isFinite(from) && from >= 0 ? from : 0,
    to: Number.isFinite(to) && to >= 0 ? to : 0,
    content
  };
}

function sortAndDedupe(cues) {
  cues.sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.content === cue.content &&
      Math.abs(prev.from - cue.from) < 0.001 &&
      Math.abs(prev.to - cue.to) < 0.001
    ) {
      continue;
    }
    out.push(cue);
  }
  return out;
}

function parseSubtitleJson(data) {
  const body = data && Array.isArray(data.body) ? data.body : [];
  const cues = [];
  for (const raw of body) {
    const cue = parseCue(raw);
    if (cue) cues.push(cue);
  }
  return sortAndDedupe(cues);
}

BS.parseSubtitleJson = parseSubtitleJson;
BS.sortAndDedupe = sortAndDedupe;
