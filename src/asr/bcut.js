/*
 * Bcut (必剪) cloud speech recognition client.
 *
 * Bilibili's own audio-to-text service, used by the 必剪 editor. It needs
 * no API key and — verified 2026-11-19 — no login cookies: the resource
 * upload uses presigned object-storage URLs and the task endpoints answer
 * anonymously.
 *
 * Flow (all JSON in `data`, `code 0` = ok):
 *   POST /resource/create          {type:2, name, size, resource_file_type, model_id:7}
 *        -> {resource_id, in_boss_key, upload_id, upload_urls[], per_size}
 *   PUT  upload_urls[i]            raw bytes of part i  -> ETag header
 *   POST /resource/create/complete {in_boss_key, resource_id, etags, upload_id, model_id:7}
 *        -> {download_url}
 *   POST /task                     {resource: download_url, model_id:"7"} -> {task_id}
 *   GET  /task/result?model_id=7&task_id=...  -> {state, remark, result(JSON string)}
 *        state: 0 stopped, 1 running, 3 error, 4 complete
 *   result JSON: {utterances:[{start_time, end_time, transcript, words[]}], version}
 *   (start_time / end_time are milliseconds)
 *
 * Everything is injectable (net, sleep) so the whole flow runs under
 * node:test without network.
 */

const BCUT_API_BASE = 'https://member.bilibili.com/x/bcut/rubick-interface';
const BCUT_MODEL_ID = 7;
const BCUT_POLL_MS = 1500;
const BCUT_MAX_POLL_MS = 10 * 60 * 1000;
const BCUT_MAX_PARTS = 200;

function bcutError(message, phase, code) {
  const e = new Error(message);
  e.phase = phase || '';
  if (code != null) e.code = code;
  return e;
}

function unwrap(resp, phase) {
  if (!resp || typeof resp.code !== 'number') {
    throw bcutError('必剪接口响应缺少 code 字段', phase);
  }
  if (resp.code !== 0) {
    throw bcutError(
      `必剪接口返回 code ${resp.code}：${resp.message || '未知错误'}`,
      phase,
      resp.code
    );
  }
  return resp.data || {};
}

/* Presigned URLs come back as plain http://; https on the same host keeps
 * the signature valid and avoids an insecure request from the page. */
function secureUrl(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Bcut shares Bilibili's risk-control layer: repeating the flow many times
 * from one address eventually answers HTTP 412 with a captcha page (verified
 * 2026-11-19 after ~4 anonymous runs in one session). Translate that into
 * something the user can act on instead of a bare "HTTP 412".
 */
function callNet(fn, phase) {
  return Promise.resolve()
    .then(fn)
    .catch((e) => {
      if (e && e.status === 412) {
        const err = bcutError(
          '必剪接口返回 HTTP 412（B 站安全网关拦截）：网关会要求人工完成图片验证码；' +
            '点「打开验证页」在新标签页完成验证；完成并回到本页会自动重试一次，' +
            '也可以点「已通过，重试」，或者换网络（如手机热点）',
          phase,
          412
        );
        err.status = 412;
        throw err;
      }
      if (e && e.status === 429) {
        const err = bcutError('必剪接口限流（HTTP 429）：请稍后重试', phase, 429);
        err.status = 429;
        throw err;
      }
      throw e;
    });
}

/* Upload the audio and create a recognition task; returns its task id. */
async function startTask(bytes, { net, fileName, stage, ensureAlive }) {
  // 1. apply for upload slots
  stage('create');
  const created = unwrap(
    await callNet(() => net.postForm(
      `${BCUT_API_BASE}/resource/create`,
      {
        type: 2,
        name: fileName,
        size: bytes.length,
        resource_file_type: 'm4a',
        model_id: BCUT_MODEL_ID
      },
      { phase: 'asr-bcut-create', timeout: 30000 }
    ), 'asr-bcut-create'),
    'asr-bcut-create'
  );

  const resourceId = String(created.resource_id || '');
  const inBossKey = String(created.in_boss_key || '');
  const uploadId = String(created.upload_id || '');
  const uploadUrls = Array.isArray(created.upload_urls) ? created.upload_urls : [];
  const perSize = Number(created.per_size) || bytes.length;
  if (!resourceId || !inBossKey || !uploadId || !uploadUrls.length) {
    throw bcutError('必剪接口没有返回可用的上传信息', 'asr-bcut-create');
  }
  if (uploadUrls.length > BCUT_MAX_PARTS) {
    throw bcutError('音频分片过多，已超出上限', 'asr-bcut-create');
  }

  // 2. upload every part (raw bytes, no transcoding: DASH audio is m4a)
  const etags = [];
  for (let i = 0; i < uploadUrls.length; i += 1) {
    ensureAlive();
    const start = i * perSize;
    const part = bytes.subarray(start, Math.min(start + perSize, bytes.length));
    const res = await callNet(
      () => net.putBinary(secureUrl(uploadUrls[i]), part, { phase: 'asr-bcut-upload' }),
      'asr-bcut-upload'
    );
    const etag = res && res.headers && (res.headers.etag || res.headers.ETag);
    if (!etag) throw bcutError('分片上传未返回 ETag', 'asr-bcut-upload');
    etags.push(etag);
    stage('upload', { done: i + 1, total: uploadUrls.length });
  }

  // 3. commit the upload
  stage('complete');
  ensureAlive();
  const completed = unwrap(
    await callNet(() => net.postForm(
      `${BCUT_API_BASE}/resource/create/complete`,
      {
        in_boss_key: inBossKey,
        resource_id: resourceId,
        etags: etags.join(','),
        upload_id: uploadId,
        model_id: BCUT_MODEL_ID
      },
      { phase: 'asr-bcut-complete', timeout: 30000 }
    ), 'asr-bcut-complete'),
    'asr-bcut-complete'
  );
  const downloadUrl = String(completed.download_url || '');
  if (!downloadUrl) throw bcutError('必剪接口没有返回下载地址', 'asr-bcut-complete');

  // 4. create the recognition task
  stage('task');
  ensureAlive();
  const task = unwrap(
    await callNet(() => net.postJson(
      `${BCUT_API_BASE}/task`,
      { resource: downloadUrl, model_id: String(BCUT_MODEL_ID) },
      { phase: 'asr-bcut-task', timeout: 30000 }
    ), 'asr-bcut-task'),
    'asr-bcut-task'
  );
  const taskId = String(task.task_id || '');
  if (!taskId) throw bcutError('必剪接口没有返回任务 id', 'asr-bcut-task');
  return taskId;
}

/*
 * Poll an existing task. This is the only step that hits the risk-controlled
 * /task/result endpoint, so it can be resumed later without re-uploading.
 */
async function waitForResult(taskId, { net, stage, ensureAlive, sleep, pollMs, maxPollMs }) {
  const startedAt = Date.now();
  for (;;) {
    ensureAlive();
    const state = unwrap(
      await callNet(() => net.getJson(
        `${BCUT_API_BASE}/task/result?model_id=${BCUT_MODEL_ID}&task_id=${encodeURIComponent(taskId)}`,
        { phase: 'asr-bcut-result', timeout: 30000 }
      ), 'asr-bcut-result'),
      'asr-bcut-result'
    );

    const code = Number(state.state);
    if (code === 4) {
      return { utterances: parseUtterances(state.result), remark: String(state.remark || '') };
    }
    if (code === 3) {
      throw bcutError(`语音识别失败：${state.remark || '未知原因'}`, 'asr-bcut-result');
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxPollMs) {
      throw bcutError('语音识别超时，请稍后重试', 'asr-bcut-result');
    }
    stage('poll', { elapsedMs: elapsed, state: code });
    // Back off so a stuck task cannot hammer the endpoint: 1x, 2x, 3x, 4x.
    await sleep(pollMs * Math.min(4, 1 + Math.floor(elapsed / 20000)));
  }
}

async function transcribe(bytes, opts = {}) {
  const {
    env,
    onStage,
    isCancelled,
    fileName = 'audio.m4a',
    sleep = defaultSleep,
    pollMs = BCUT_POLL_MS,
    maxPollMs = BCUT_MAX_POLL_MS,
    existingTaskId = '',
    onTask = null
  } = opts;

  const net = (env && env.net) || BS.net;
  const stage = (name, info) => {
    if (onStage) onStage(name, info || {});
  };
  const ensureAlive = () => {
    if (isCancelled && isCancelled()) throw bcutError('已取消语音识别', 'bcut-cancel');
  };

  // A remembered task id skips the whole upload: useful when a previous run
  // already uploaded the audio and only the result query was blocked (412).
  let taskId = String(existingTaskId || '');
  const resumed = Boolean(taskId);

  if (resumed) {
    stage('resume', { taskId });
  } else {
    if (!bytes || !bytes.length) throw bcutError('音频为空，无法识别', 'bcut-input');
    if (bytes.length < 1024) throw bcutError('音频过短，无法识别', 'bcut-input');
    taskId = await startTask(bytes, { net, fileName, stage, ensureAlive });
    if (onTask) onTask(taskId);
  }

  const result = await waitForResult(taskId, {
    net, stage, ensureAlive, sleep, pollMs, maxPollMs
  });
  return { ...result, taskId, resumed };
}

function parseUtterances(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw bcutError('识别结果不是合法 JSON', 'asr-bcut-result');
    }
  }
  const list = parsed && Array.isArray(parsed.utterances) ? parsed.utterances : [];
  return list;
}

BS.asrBcut = {
  transcribe,
  parseUtterances,
  secureUrl,
  API_BASE: BCUT_API_BASE,
  MODEL_ID: BCUT_MODEL_ID
};
