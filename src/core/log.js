/*
 * Logging with a unified prefix and URL sanitization.
 *
 * Short-lived signed query parameters (auth_key, tokens, signatures)
 * must never appear in logs, and cookies are never read or logged.
 */

const SENSITIVE_PARAMS =
  /^(auth_key|authkey|token|sign|signature|w_rid|wts|session|sessdata|osa|credential|secret|access_key)$/i;

const SENSITIVE_PARAM_HINT =
  /^(auth|token|sign|w_|session|osa|credential|secret|access)/i;

function maskValue(value) {
  if (!value) return '***';
  if (value.length <= 4) return '***';
  return value.slice(0, 2) + '***' + value.slice(-2);
}

function sanitizeQueryValue(key, value) {
  if (SENSITIVE_PARAMS.test(key)) return '***';
  if (SENSITIVE_PARAM_HINT.test(key) && value.length >= 12) return '***';
  if (/^[0-9a-f]{16,}$/i.test(value)) return '***';
  return value;
}

function sanitizePath(path) {
  return path.replace(
    /[0-9a-f]{24,}/gi,
    (m) => m.slice(0, 6) + '***'
  );
}

function sanitizeUrl(rawUrl) {
  const url = String(rawUrl || '');
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return sanitizePath(url);

  const base = sanitizePath(url.slice(0, qIndex));
  const query = url.slice(qIndex + 1);

  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      return `${key}=${sanitizeQueryValue(key, value)}`;
    })
    .join('&');

  return `${base}?${masked}`;
}

function log(...args) {
  console.log(BS.TAG, ...args);
}

function warn(...args) {
  console.warn(BS.TAG, ...args);
}

function errorLog(...args) {
  console.error(BS.TAG, ...args);
}

BS.log = log;
BS.warn = warn;
BS.errorLog = errorLog;
BS.sanitizeUrl = sanitizeUrl;
