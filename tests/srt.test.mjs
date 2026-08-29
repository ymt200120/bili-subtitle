import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

const BS = loadSrc();
const { fmtClock, toPlainText, toTimestampedText, toSrt, toJson, safeName } = BS.exporters;

test('SRT clock format uses comma milliseconds', () => {
  assert.equal(fmtClock(1.2, true), '00:00:01,200');
  assert.equal(fmtClock(3.4, true), '00:00:03,400');
});

test('SRT clock rolls over hours', () => {
  assert.equal(fmtClock(3661.5, true), '01:01:01,500');
});

test('plain clock omits hours when zero', () => {
  assert.equal(fmtClock(59.2), '00:59');
  assert.equal(fmtClock(61), '01:01');
  assert.equal(fmtClock(0), '00:00');
});

test('SRT output shape', () => {
  const srt = toSrt([{ from: 1.2, to: 3.4, content: 'hi' }]);
  assert.equal(srt, '1\n00:00:01,200 --> 00:00:03,400\nhi\n');
});

test('plain and timestamped text', () => {
  const cues = [
    { from: 1, to: 2, content: 'a' },
    { from: 3, to: 4, content: 'b' }
  ];
  assert.equal(toPlainText(cues), 'a\nb');
  assert.equal(toTimestampedText(cues), '00:01  a\n00:03  b');
});

test('JSON export carries video + track + generator, no signed URL', () => {
  const video = { bvid: 'BV1', aid: 2, cid: 3, page: 1, title: 'T' };
  const track = { lan: 'ai-zh', lanDoc: '中文（AI）', source: 'web-view', url: 'https://x/?auth_key=SECRET' };
  const json = JSON.parse(toJson(video, track, [{ from: 0, to: 1, content: 'a' }]));
  assert.equal(json.video.bvid, 'BV1');
  assert.equal(json.track.lan, 'ai-zh');
  assert.equal(json.body.length, 1);
  assert.match(json.generator, /^bili-subtitle \d/);
  assert.ok(!JSON.stringify(json).includes('SECRET'));
});

test('safeName strips filesystem-hostile characters', () => {
  assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeName(''), 'bilibili-subtitle');
});
