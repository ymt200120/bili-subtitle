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

/*
 * env = { net, ... } (the same env the resolver pipeline uses)
 * opts = { onProgress({text, percent}), onStage(name, info), isCancelled() }
 */
async function generate(ctx, env, opts = {}) {
  const onProgress = opts.onProgress || null;
  const onStage = opts.onStage || null;
  const isCancelled = opts.isCancelled || null;
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

  report('解析音频流…', 2);
  alive();
  const stream = await BS.audio.resolveStream(ctx, env);
  if (onStage) onStage('stream', { id: stream.id, bandwidth: stream.bandwidth });

  report('下载音频…', 3);
  const audio = await BS.audio.download(stream, {
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
  const asr = await BS.asrBcut.transcribe(audio, {
    env,
    fileName: `${ctx.bvid}-${ctx.cid}.m4a`,
    isCancelled,
    sleep: opts.sleep,
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
      } else {
        report(stageText(name, info), 46);
      }
      if (onStage) onStage(name, info);
    }
  });

  alive();
  report('整理字幕…', 96);
  const cues = toCues(asr.utterances);
  if (!cues.length) {
    throw new Error('语音识别完成，但没有识别到可用的语音内容');
  }

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

  report('语音识别完成', 100);
  return {
    track,
    cues,
    audio: { bytes: audio.byteLength, id: stream.id, bandwidth: stream.bandwidth },
    utterances: asr.utterances.length,
    taskId: asr.taskId
  };
}

BS.asr = {
  generate,
  toCues,
  LAN: ASR_LAN,
  LAN_DOC: ASR_LAN_DOC,
  SOURCE: ASR_SOURCE
};
