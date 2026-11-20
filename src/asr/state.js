/*
 * ASR session state: resumable tasks, result cache and the 412 cooldown.
 *
 * Why this exists: Bcut's /task/result endpoint is behind Bilibili's risk
 * control. Once it answers HTTP 412, the block lasts for a long time
 * (measured: still blocked ~1.5 h later; upstream issue
 * SocialSisterYi/bcut-asr#12 has no fix). Re-uploading the same audio on
 * every retry both wastes bandwidth and keeps feeding the limiter, so:
 *
 *   - a created task id is remembered, and a later click only polls it
 *     (no audio download, no upload) as long as it is fresh;
 *   - a successful recognition is cached per video, so re-extracting the
 *     same video does not run ASR again;
 *   - after a 412 the cooldown is remembered and requests are skipped until
 *     it expires, instead of hammering an endpoint that is already blocking.
 *
 * Only ids, timestamps and the recognised cues are stored (never audio and
 * never any URL/Cookie). Storage is localStorage when available, otherwise
 * an in-memory fallback, and every access is guarded: a full or disabled
 * storage degrades to "no state", never to a crash.
 */

const ASR_STATE_KEY = 'bili-subtitle.asr.v1';
const ASR_TASK_TTL_MS = 2 * 60 * 60 * 1000;
const ASR_BAN_TTL_MS = 30 * 60 * 1000;
const ASR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ASR_CACHE_LIMIT = 20;

function asrMemoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}

function asrDefaultStore() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const probe = '__bili_subtitle_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (_) { /* private mode / disabled storage */ }
  return asrMemoryStore();
}

function loadState(store) {
  let parsed = {};
  try {
    parsed = JSON.parse((store || asrDefaultStore()).getItem(ASR_STATE_KEY) || '{}') || {};
  } catch (_) {
    parsed = {};
  }
  return {
    tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
    cache: parsed.cache && typeof parsed.cache === 'object' ? parsed.cache : {},
    banUntil: Number(parsed.banUntil) || 0
  };
}

function saveState(state, store) {
  try {
    (store || asrDefaultStore()).setItem(ASR_STATE_KEY, JSON.stringify(state));
  } catch (_) { /* quota / disabled storage: state is best-effort */ }
}

function isFresh(entry, now, ttl) {
  const at = Number(entry && entry.createdAt) || 0;
  return at > 0 && now - at >= 0 && now - at <= ttl;
}

function taskFor(state, ctxKey, now) {
  const task = state.tasks[ctxKey];
  if (!task || !task.taskId) return null;
  if (!isFresh(task, now, ASR_TASK_TTL_MS)) {
    delete state.tasks[ctxKey];
    return null;
  }
  return task;
}

function putTask(state, ctxKey, task, now) {
  state.tasks[ctxKey] = {
    taskId: String(task.taskId || ''),
    createdAt: Number(task.createdAt) || now
  };
}

function dropTask(state, ctxKey) {
  delete state.tasks[ctxKey];
}

function banRemaining(state, now) {
  return Math.max(0, (Number(state.banUntil) || 0) - now);
}

function setBan(state, now, ms = ASR_BAN_TTL_MS) {
  state.banUntil = now + ms;
  return state.banUntil;
}

function clearBan(state) {
  state.banUntil = 0;
}

function cachedFor(state, ctxKey, now) {
  const entry = state.cache[ctxKey];
  if (!entry || !Array.isArray(entry.cues) || !entry.cues.length) return null;
  if (!isFresh(entry, now, ASR_CACHE_TTL_MS)) {
    delete state.cache[ctxKey];
    return null;
  }
  return entry;
}

function putCache(state, ctxKey, cues, now) {
  state.cache[ctxKey] = { cues, count: cues.length, createdAt: now };
  const keys = Object.keys(state.cache).sort(
    (a, b) => (Number(state.cache[a].createdAt) || 0) - (Number(state.cache[b].createdAt) || 0)
  );
  while (keys.length > ASR_CACHE_LIMIT) delete state.cache[keys.shift()];
}

BS.asrState = {
  KEY: ASR_STATE_KEY,
  TASK_TTL_MS: ASR_TASK_TTL_MS,
  BAN_TTL_MS: ASR_BAN_TTL_MS,
  CACHE_TTL_MS: ASR_CACHE_TTL_MS,
  CACHE_LIMIT: ASR_CACHE_LIMIT,
  memoryStore: asrMemoryStore,
  defaultStore: asrDefaultStore,
  loadState,
  saveState,
  taskFor,
  putTask,
  dropTask,
  banRemaining,
  setBan,
  clearBan,
  cachedFor,
  putCache
};
