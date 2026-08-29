/*
 * Network layer. Prefers GM_xmlhttpRequest (bypasses CORS, carries
 * bilibili login cookies automatically for api.bilibili.com) and falls
 * back to page-context fetch with credentials when GM is unavailable.
 *
 * Errors carry structured info (phase / httpStatus / sanitized endpoint)
 * for the diagnostics UI. Cookie values are never read or logged.
 */

function gmRequest(options) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      timeout: 15000,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://www.bilibili.com/'
      },
      ...options,
      onload: (r) => resolve(r),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout'))
    });
  });
}

function pageFetch(url, { responseType } = {}) {
  const consume =
    responseType === 'arraybuffer'
      ? (r) => r.arrayBuffer().then((buffer) => ({
          status: r.status,
          response: buffer,
          contentType: r.headers.get('content-type') || ''
        }))
      : (r) => r.text().then((text) => ({
          status: r.status,
          response: text,
          contentType: r.headers.get('content-type') || ''
        }));

  return fetch(url, {
    method: 'GET',
    credentials: 'include'
  }).then(consume);
}

class NetError extends Error {
  constructor(message, { status, endpoint, phase, body } = {}) {
    super(message);
    this.name = 'NetError';
    this.status = status || 0;
    this.endpoint = endpoint ? BS.sanitizeUrl(endpoint) : '';
    this.phase = phase || '';
    this.body = body ? String(body).slice(0, 200) : '';
  }
}

async function request(url, { phase = '', responseType = 'text', timeout = 15000 } = {}) {
  let status;
  let response;
  let contentType;

  if (typeof GM_xmlhttpRequest === 'function') {
    try {
      const r = await gmRequest({ url, timeout, responseType });
      status = r.status;
      contentType = r.responseHeaders || '';
      response = responseType === 'arraybuffer' ? r.response : r.responseText;
    } catch (e) {
      throw new NetError(`网络错误或超时：${e.message}`, {
        endpoint: url,
        phase
      });
    }
  } else {
    try {
      const r = await pageFetch(url, { responseType });
      status = r.status;
      contentType = r.contentType;
      response = r.response;
    } catch (e) {
      throw new NetError(`网络错误：${e.message}`, {
        endpoint: url,
        phase
      });
    }
  }

  if (status < 200 || status >= 300) {
    let body = '';
    try {
      if (responseType === 'arraybuffer') {
        body = new TextDecoder().decode(new Uint8Array(response)).slice(0, 120);
      } else {
        body = String(response).slice(0, 120);
      }
    } catch (_) { /* ignore */ }
    throw new NetError(`HTTP ${status}`, { status, endpoint: url, phase, body });
  }

  return { status, response, contentType };
}

async function getJson(url, opts = {}) {
  const { response } = await request(url, { ...opts, responseType: 'text' });
  try {
    return JSON.parse(response);
  } catch (e) {
    throw new NetError('返回内容不是 JSON', {
      endpoint: url,
      phase: opts.phase || 'parse-json',
      body: String(response)
    });
  }
}

async function getBinary(url, opts = {}) {
  const { response } = await request(url, { ...opts, responseType: 'arraybuffer' });
  return response instanceof ArrayBuffer ? response : new Uint8Array(response).buffer;
}

BS.net = { request, getJson, getBinary, NetError };
