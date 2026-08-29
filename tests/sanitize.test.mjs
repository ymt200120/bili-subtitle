import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

const BS = loadSrc();

test('signed query params are masked', () => {
  const url =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/1/x?auth_key=abcdef123456&oid=40065631429';
  const out = BS.sanitizeUrl(url);
  assert.ok(out.includes('auth_key=***'), out);
  assert.ok(out.includes('oid=40065631429'), out);
  assert.ok(!out.includes('abcdef123456'), out);
});

test('wbi signing params are masked', () => {
  const out = BS.sanitizeUrl('https://api.bilibili.com/x?a=1&w_rid=deadbeef0011&wts=1720000000');
  assert.ok(out.includes('w_rid=***'), out);
  assert.ok(out.includes('wts=***'), out);
  assert.ok(!out.includes('deadbeef0011'), out);
});

test('long hex path segments are masked', () => {
  const out = BS.sanitizeUrl('https://x/bfs/ai_subtitle/proxy/aabbccddeeff00112233445566778899/file');
  assert.ok(!out.includes('aabbccddeeff00112233445566778899'), out);
  assert.ok(out.includes('aabbcc***'), out);
});

test('short numeric ids stay visible for diagnostics', () => {
  const out = BS.sanitizeUrl('https://api.bilibili.com/x?cid=40065631429&bvid=BV1BbKw6XEWq');
  assert.ok(out.includes('cid=40065631429'), out);
  assert.ok(out.includes('bvid=BV1BbKw6XEWq'), out);
});

test('diagnostics render ok/fail/skip marks and hide signed endpoints', () => {
  const diag = BS.diagnostics.createDiagnostics();
  diag.add({ resolver: 'legacy-json', status: BS.diagnostics.OK, detail: '2 条轨道' });
  diag.add({
    resolver: 'legacy-json#fetch',
    status: BS.diagnostics.FAIL,
    detail: 'HTTP 404',
    httpStatus: 404,
    endpoint: 'https://aisubtitle.hdslb.com/x?auth_key=SECRET'
  });
  diag.add({ resolver: 'player-resource', status: BS.diagnostics.SKIP, detail: '等待播放器请求' });

  const lines = diag.render();
  assert.match(lines[0], /^✓ legacy-json · 2 条轨道$/);
  assert.match(lines[1], /^✗ legacy-json#fetch · HTTP 404 · HTTP 404/);
  assert.ok(lines[1].includes('auth_key=***'));
  assert.ok(!lines[1].includes('SECRET'));
  assert.match(lines[2], /^○ player-resource/);
});

test('logger helpers exist and never throw on odd input', () => {
  BS.log('x', null, undefined, 1);
  BS.warn();
  BS.errorLog(BS.sanitizeUrl(''));
  BS.sanitizeUrl(null);
  assert.ok(true);
});
