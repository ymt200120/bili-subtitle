/*
 * Resolver diagnostics. One Step per resolver attempt, rendered as
 * ✓ / ✗ / ○ lines for the UI and console. Endpoints are sanitized
 * before being stored or displayed.
 *
 * Since v1.0.2 each extract run carries a runId, the resolved video
 * context and the final decision block, so a single copied diag block
 * identifies which resolver won and why the others were ignored.
 */

const OK = 'ok';
const FAIL = 'fail';
const SKIP = 'skip';

function createDiagnostics(opts = {}) {
  const steps = [];
  const meta = { runId: opts.runId || 0, context: null, decision: [] };

  function add(step) {
    steps.push({
      resolver: step.resolver || '',
      status: step.status || FAIL,
      detail: step.detail || '',
      httpStatus: step.httpStatus || 0,
      endpoint: step.endpoint ? BS.sanitizeUrl(step.endpoint) : '',
      trust: step.trust || '',
      ms: step.ms || 0
    });
  }

  function setContext(ctx) {
    meta.context = ctx || null;
  }

  function setDecision(lines) {
    meta.decision = Array.isArray(lines) ? lines.slice() : [];
  }

  function renderStep(s) {
    const mark = s.status === OK ? '✓' : s.status === SKIP ? '○' : '✗';
    const parts = [`${mark} ${s.resolver}`];
    if (s.trust) parts.push(`[${s.trust}]`);
    if (s.detail) parts.push(s.detail);
    if (s.httpStatus) parts.push(`HTTP ${s.httpStatus}`);
    if (s.endpoint) parts.push(s.endpoint);
    if (s.ms) parts.push(`${s.ms}ms`);
    return parts.join(' · ');
  }

  function render() {
    const out = [];
    if (meta.runId) out.push(`Extract run #${meta.runId}`);
    const c = meta.context;
    if (c) {
      out.push(
        `Context · ${c.bvid} · aid ${c.aid} · cid ${c.cid} · P${c.page} · key ${c.contextKey}`
      );
    }
    if (out.length) out.push('');
    for (const s of steps) out.push(renderStep(s));
    if (meta.decision.length) {
      out.push('');
      for (const line of meta.decision) out.push(line);
    }
    return out;
  }

  return { steps, add, setContext, setDecision, render, runId: meta.runId };
}

BS.diagnostics = { createDiagnostics, OK, FAIL, SKIP };
