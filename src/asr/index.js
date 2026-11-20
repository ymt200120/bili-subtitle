/*
 * ASR fallback: generate subtitles for videos whose uploader never enabled
 * CC / AI subtitles.
 *
 *   signed playurl (audio stream)  ->  download  ->  Bcut ASR  ->  cues
 *
 * The result is a first-class track (trust ASR_TRANSCRIPT) bound to the
 * current video context, so the existing preview / export / diagnostics
 * paths work unchanged. Nothing runs unless the user asks for it: the
 * audio is downloaded and uploaded only after an explicit click.
 */

const ASR_LAN = 'asr-zh';
const ASR_LAN_DOC = '中文（语音识别）';
const ASR_SOURCE = 'asr';

/* Milliseconds -> seconds cues; drop music markers and empty lines. */
function toCues(utterances) {
  const cues = [];
  for (const u of Array.isArray(utterances) ? utterances : []) {
    if (!u) continue;
    if (Number(u.music) === 1) continue;
    const content = String(u.transcript == null ? '' : u.transcript).trim();
    if (!content) continue;
    const from = Number(u.start_time) / 1000;
    const to = Number(u.end_time) / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) continue;
    cues.push({ from, to: to > from ? to : from + 0.01, content });
  }
  return BS.sortAndDedupe(cues);
}

function stageText(stage, info) {
  switch (stage) {
    case 'create':
      return '申请上传…';
    case 'upload':
      return `上传音频 ${info.done}/${info.total}…`;
    case 'complete':
      return '提交音频…';
    case 'task':
      return '创建识别任务…';
    case 'poll':
      return `识别中…已用时 ${Math.round((info.elapsedMs || 0) / 1000)} 秒`;
    default:
      return '处理中…';
  }
}

/* Build the ASR track for a set of cues (shared by fresh, cached, resumed). */
function makeAsrTrack(ctx, cues) {
  const track = BS.makeTrack({
    id: 'asr',
    lan: ASR_LAN,
    lanDoc: ASR_LAN_DOC,
    url: '',
    source: ASR_SOURCE,
    contextKey: ctx.contextKey,
    trust: BS.trust.ASR,
    cues
  });
  track.cues = cues;
  return track;
}

/*
 * env = { net, ... } (the same env the resolver pipeline uses)
 * opts = {
 *   onProgress({text, percent}), onStage(name, info), isCancelled(),
 *   store (defaults to localStorage), now (injectable clock)
 * }
 *
 * Bcut's /task/result sits behind Bilibili's risk control: after a few runs
 * it answers HTTP 412 and stays blocked for a long time. Hence:
 *   - a cached recognition for this video short-circuits everything;
 *   - a remembered task id resumes polling without re-downloading audio;
 *   - a 412 enters a cooldown so retries do not hammer the limiter.
 */
async function generate(ctx, env, opts = {}) {
  const onProgress = opts.onProgress || null;
  const onStage = opts.onStage || null;
  const isCancelled = opts.isCancelled || null;
  const store = opts.store || BS.asrState.defaultStore();
  const now = opts.now || (() => Date.now());
  // `force` = the user says they just solved the gateway challenge (or
  // switched network); keep the cooldown from trapping them, but still send
  // exactly one attempt.
  const force = Boolean(opts.force);
  const ctxKey = ctx.contextKey;
  const state = BS.asrState.loadState(store);

  let maxPercent = 0;
  const report = (text, percent) => {
    // Progress must never move backwards: later stages report fixed values
    // while earlier ones are ratio-based.
    maxPercent = Math.max(maxPercent, Math.max(0, Math.min(100, Math.round(percent))));
    if (onProgress) onProgress({ text, percent: maxPercent });
  };
  const alive = () => {
    if (isCancelled && isCancelled()) throw new Error('已取消语音识别');
  };

  // 0. already recognised this video? No network at all.
  const cached = BS.asrState.cachedFor(state, ctxKey, now());
  if (cached) {
    report('使用已保存的识别结果', 100);
    if (onStage) onStage('cache', { count: cached.cues.length, createdAt: cached.createdAt });
    return {
      track: makeAsrTrack(ctx, cached.cues),
      cues: cached.cues,
      audio: { bytes: 0, id: 0, bandwidth: 0 },
      utterances: Number(cached.count) || cached.cues.length,
      taskId: '',
      resumed: false,
      cached: true
    };
  }

  // 1. still inside a 412 cooldown? Fail fast instead of hitting the limiter.
  const remaining = BS.asrState.banRemaining(state, now());
  if (remaining > 0 && !force) {
    const pendingNow = BS.asrState.taskFor(state, ctxKey, now());
    const e = new Error(
      `必剪接口仍在冷却中，还需约 ${Math.max(1, Math.ceil(remaining / 60000))} 分钟不再自动发请求；` +
      `如果已在浏览器完成人机验证或换了网络，可以点「已通过，重试」立即再试一次`
    );
    e.status = 412;
    e.cooldownMs = remaining;
    e.taskPending = Boolean(pendingNow);
    if (pendingNow) e.verifyUrl = verifyUrlFor(pendingNow.taskId);
    throw e;
  }

  // 2. a task created earlier can be polled without any audio transfer.
  const pending = BS.asrState.taskFor(state, ctxKey, now());
  let taskId = pending ? pending.taskId : '';
  let audio = null;
  let stream = null;

  if (taskId) {
    report('查询已创建的识别任务…', 60);
  } else {
    report('解析音频流…', 2);
    alive();
    stream = await BS.audio.resolveStream(ctx, env);
    if (onStage) onStage('stream', { id: stream.id, bandwidth: stream.bandwidth });

    report('下载音频…', 3);
    audio = await BS.audio.download(stream, {
      env,
      isCancelled,
      onProgress: (loaded, total) => {
        const ratio = total ? loaded / total : 0;
        const mb = (loaded / 1048576).toFixed(1);
        const totalText = total ? ` / ${(total / 1048576).toFixed(1)} MB` : ' MB';
        report(`下载音频 ${mb}${totalText}…`, 3 + ratio * 42);
      }
    });
    alive();
    if (onStage) onStage('download', { bytes: audio.byteLength, id: stream.id });
    report('上传音频到必剪…', 46);
  }

  let asr;
  try {
    asr = await BS.asrBcut.transcribe(audio, {
      env,
      fileName: `${ctx.bvid}-${ctx.cid}.m4a`,
      isCancelled,
      sleep: opts.sleep,
      existingTaskId: taskId,
      // Remember the id as soon as it exists: a 412 during polling must not
      // throw away an upload that already happened.
      onTask: (id) => {
        if (!id) return;
        BS.asrState.putTask(state, ctxKey, { taskId: id }, now());
        BS.asrState.saveState(state, store);
      },
      onStage: (name, info) => {
        if (name === 'upload') {
          const ratio = info.total ? info.done / info.total : 0;
          report(`上传音频 ${info.done}/${info.total}…`, 46 + ratio * 24);
        } else if (name === 'poll') {
          const ratio = Math.min(1, (info.elapsedMs || 0) / 30000);
          report(stageText(name, info), 74 + ratio * 21);
        } else if (name === 'complete') {
          report(stageText(name, info), 71);
        } else if (name === 'task') {
          report(stageText(name, info), 72);
        } else if (name === 'resume') {
          report(`查询已有任务 ${String(info.taskId || '').slice(0, 8)}…`, 62);
        } else {
          report(stageText(name, info), 46);
        }
        if (onStage) onStage(name, info);
      }
    });
  } catch (e) {
    if (e && e.status === 412) {
      // Start a cooldown and keep the task (if any) for a later retry.
      BS.asrState.setBan(state, now());
      const keep = asrTaskIdOf(e, taskId) || BS.asrState.taskFor(state, ctxKey, now());
      const keepId = keep && keep.taskId ? keep.taskId : keep;
      if (keepId) BS.asrState.putTask(state, ctxKey, { taskId: keepId }, now());
      BS.asrState.saveState(state, store);

      const minutes = Math.max(1, Math.round(BS.asrState.BAN_TTL_MS / 60000));
      e.taskPending = Boolean(keepId);
      // The gateway answers 412 with an image captcha that only a human can
      // complete, in a real tab on member.bilibili.com. The resulting
      // X-BILI-SEC-TOKEN cookie is host-scoped there, so GM requests made
      // afterwards carry it.
      if (keepId) e.verifyUrl = verifyUrlFor(keepId);
      e.cooldownMs = BS.asrState.banRemaining(state, now());
      e.message = `${e.message}\n为避免持续撞风控，${minutes} 分钟内不再自动发请求` + (
        keepId
          ? '；识别任务已保留，冷却结束后点同一按钮会直接查询结果，不会重新下载或上传音频。'
          : '；稍后重试即可。'
      );
      throw e;
    }
    if (e && e.phase === 'asr-bcut-result') {
      BS.asrState.dropTask(state, ctxKey);
      BS.asrState.saveState(state, store);
      // TaskidNotExists (code 9): the remembered task is gone server-side.
      if (taskId && (Number(e.code) === 9 || /TaskidNotExists/i.test(String(e.message)))) {
        throw new Error('之前的识别任务已过期；再点一次会重新上传并识别。');
      }
    }
    throw e;
  }

  alive();
  report('整理字幕…', 96);
  const cues = toCues(asr.utterances);
  if (!cues.length) {
    BS.asrState.dropTask(state, ctxKey);
    BS.asrState.saveState(state, store);
    throw new Error('语音识别完成，但没有识别到可用的语音内容');
  }

  BS.asrState.dropTask(state, ctxKey);
  BS.asrState.putCache(state, ctxKey, cues, now());
  BS.asrState.clearBan(state);
  BS.asrState.saveState(state, store);

  report('语音识别完成', 100);
  return {
    track: makeAsrTrack(ctx, cues),
    cues,
    audio: {
      bytes: audio ? audio.byteLength : 0,
      id: stream ? stream.id : 0,
      bandwidth: stream ? stream.bandwidth : 0
    },
    utterances: asr.utterances.length,
    taskId: asr.taskId,
    resumed: Boolean(asr.resumed),
    cached: false
  };
}

/* The exact blocked URL: opening it in a tab shows the gateway captcha. */
function verifyUrlFor(taskId) {
  return `${'https://member.bilibili.com/x/bcut/rubick-interface/task/result'}` +
    `?model_id=7&task_id=${encodeURIComponent(String(taskId || ''))}`;
}

/* The task id survives a 412 if it was created before the block. */
function asrTaskIdOf(error, fallback) {
  if (error && error.taskId) return String(error.taskId);
  return fallback ? String(fallback) : '';
}

BS.asr = {
  generate,
  toCues,
  LAN: ASR_LAN,
  LAN_DOC: ASR_LAN_DOC,
  SOURCE: ASR_SOURCE
};
