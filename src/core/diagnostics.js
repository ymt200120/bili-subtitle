/*
 * Resolver diagnostics. One Step per resolver attempt, rendered as
 * ✓ / ✗ / ○ lines for the UI and console. Endpoints are sanitized
 * before being stored or displayed.
 */

const OK = 'ok';
const FAIL = 'fail';
const SKIP = 'skip';

function createDiagnostics() {
  const steps = [];

  function add(step) {
    steps.push({
      resolver: step.resolver || '',
      status: step.status || FAIL,
      detail: step.detail || '',
      httpStatus: step.httpStatus || 0,
      endpoint: step.endpoint ? BS.sanitizeUrl(step.endpoint) : '',
      ms: step.ms || 0
    });
  }

  function render() {
    return steps.map((s) => {
      const mark = s.status === OK ? '✓' : s.status === SKIP ? '○' : '✗';
      const parts = [`${mark} ${s.resolver}`];
      if (s.detail) parts.push(s.detail);
      if (s.httpStatus) parts.push(`HTTP ${s.httpStatus}`);
      if (s.endpoint) parts.push(s.endpoint);
      if (s.ms) parts.push(`${s.ms}ms`);
      return parts.join(' · ');
    });
  }

  return { steps, add, render };
}

BS.diagnostics = { createDiagnostics, OK, FAIL, SKIP };
