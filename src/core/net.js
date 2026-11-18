/*
 * Network layer. Prefers GM_xmlhttpRequest (bypasses CORS, carries
 * bilibili login cookies automatically for api.bilibili.com) and falls
 * back to page-context fetch with credentials when GM is unavailable.
 *
 * Supports GET / POST (form or JSON) / PUT with binary bodies so the ASR
 * fallback can talk to the Bcut (必剪) endpoints through the same
 * error/diagnostic plumbing.
 *
 * Errors carry structured info (phase / httpStatus / sanitized endpoint)
 * for the diagnostics UI. Cookie values are never read or logged.
 */

function gmRequest(options) {
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    Referer: 'https://www.bilibili.com/',
    ...(options.headers || {})
  };
  const rest = { ...options };
  delete rest.headers;

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: options.method || 'GET',
      timeout: options.timeout || 15000,
      responseType: options.responseType,
      data: options.data,
      url: options.url,
      headers,
      ...rest,
      onload: (r) => resolve(r),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout'))
    });
  });
}

function pageFetch(url, { responseType, method = 'GET', headers = {}, body = null } = {}) {
  const consume =
    responseType === 'arraybuffer'
      ? (r) => r.arrayBuffer().then((buffer) => ({
          status: r.status,
          response: buffer,
          headerLines: serializeHeaders(r.headers)
        }))
      : (r) => r.text().then((text) => ({
          status: r.status,
          response: text,
          headerLines: serializeHeaders(r.headers)
        }));

  const init = { method, credentials: 'include', headers };
  if (body != null) init.body = body;
  return fetch(url, init).then(consume);
}

function serializeHeaders(headers) {
  const lines = [];
  try {
    headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  } catch (_) { /* ignore */ }
  return lines.join('\n');
}

/* "HTTP/1.1 200 OK\r\nA: b\r\n" (GM) or serialized lines (fetch) -> map */
function parseHeaders(raw) {
  const out = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (!key || /^https?$/.test(key)) continue;
    out[key] = value;
  }
  return out;
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

async function request(url, opts = {}) {
  const {
    phase = '',
    responseType = 'text',
    timeout = 15000,
    method = 'GET',
    headers = {},
    body = null
  } = opts;

  let status;
  let response;
  let rawHeaders = '';

  if (typeof GM_xmlhttpRequest === 'function') {
    try {
      const r = await gmRequest({
        url,
        method,
        headers,
        data: body == null ? undefined : body,
        timeout,
        responseType
      });
      status = r.status;
      rawHeaders = r.responseHeaders || '';
      response = responseType === 'arraybuffer' ? r.response : r.responseText;
    } catch (e) {
      throw new NetError(`网络错误或超时：${e.message}`, {
        endpoint: url,
        phase
      });
    }
  } else {
    try {
      const r = await pageFetch(url, { responseType, method, headers, body });
      status = r.status;
      response = r.response;
      rawHeaders = r.headerLines || '';
    } catch (e) {
      throw new NetError(`网络错误：${e.message}`, {
        endpoint: url,
        phase
      });
    }
  }

  if (status < 200 || status >= 300) {
    let bodyText = '';
    try {
      if (responseType === 'arraybuffer') {
        bodyText = new TextDecoder().decode(new Uint8Array(response)).slice(0, 120);
      } else {
        bodyText = String(response).slice(0, 120);
      }
    } catch (_) { /* ignore */ }
    throw new NetError(`HTTP ${status}`, { status, endpoint: url, phase, body: bodyText });
  }

  const headerMap = parseHeaders(rawHeaders);
  return {
    status,
    response,
    headers: headerMap,
    contentType: headerMap['content-type'] || ''
  };
}

async function parseJsonResponse(url, opts) {
  const { response } = await request(url, { ...opts, responseType: 'text' });
  try {
    return JSON.parse(response);
  } catch (e) {
    throw new NetError('返回内容不是 JSON', {
      endpoint: url,
      phase: (opts && opts.phase) || 'parse-json',
      body: String(response)
    });
  }
}

async function getJson(url, opts = {}) {
  return parseJsonResponse(url, opts);
}

async function postForm(url, params, opts = {}) {
  return parseJsonResponse(url, {
    ...opts,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(opts.headers || {})
    },
    body: new URLSearchParams(params).toString()
  });
}

async function postJson(url, payload, opts = {}) {
  return parseJsonResponse(url, {
    ...opts,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    },
    body: JSON.stringify(payload)
  });
}

/*
 * Binary PUT (presigned object-storage upload). Returns status + headers
 * so callers can read the ETag of each uploaded part.
 */
async function putBinary(url, data, opts = {}) {
  const bytes = toBuffer(data);
  const base = {
    ...opts,
    method: 'PUT',
    responseType: 'text',
    timeout: opts.timeout || 120000
  };
  try {
    return await request(url, { ...base, body: bytes });
  } catch (e) {
    // Some userscript managers reject ArrayBuffer request bodies; retry a
    // transport-level failure once with a Blob. HTTP errors are real
    // answers and are not retried.
    if ((e && e.status) || typeof Blob !== 'function') throw e;
    return request(url, { ...base, body: new Blob([bytes]) });
  }
}

async function getBinary(url, opts = {}) {
  const { response } = await request(url, { ...opts, responseType: 'arraybuffer' });
  return toBuffer(response);
}

function toBuffer(data) {
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

BS.net = { request, getJson, getBinary, postForm, postJson, putBinary, NetError };
