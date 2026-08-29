import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSrc,
  fieldVarint,
  fieldBytes,
  fieldString,
  concat,
  makeTrackMessage,
  makeWebViewMessage
} from './load.mjs';

const BS = loadSrc();

function decode(buffer) {
  return BS.protobuf.decodeWebViewTracks(buffer);
}

function fieldFixed(no, size) {
  const wt = size === 8 ? 1 : 5;
  let n = no * 8 + wt;
  const head = [];
  for (;;) {
    head.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    if (n < 0x80) break;
    n = Math.floor(n / 128);
  }
  head.reverse();
  return Uint8Array.from([...head, ...new Uint8Array(size)]);
}

test('decodes two subtitle tracks (nested data -> repeated tracks)', () => {
  const track1 = makeTrackMessage({
    id: 10,
    lan: 'ai-zh',
    lanDoc: '中文（AI）',
    url: '//aisubtitle.hdslb.com/x/one?auth_key=abc',
    label: '中文'
  });
  const track2 = makeTrackMessage({
    id: 11,
    lan: 'zh-Hans',
    lanDoc: '中文（简体）',
    url: '//subtitle.bilibili.com/x/two?auth_key=def'
  });
  const { empty, tracks } = decode(makeWebViewMessage([track1, track2]));

  assert.equal(empty, false);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].lan, 'ai-zh');
  assert.equal(tracks[0].lanDoc, '中文（AI）');
  assert.equal(tracks[0].id, 10);
  assert.equal(tracks[0].idStr, '10');
  assert.equal(tracks[0].label, '中文');
  assert.equal(tracks[0].url, '//aisubtitle.hdslb.com/x/one?auth_key=abc');
  assert.equal(tracks[1].lan, 'zh-Hans');
});

test('multi-byte varint ids decode correctly', () => {
  const track = makeTrackMessage({
    id: 300,
    lan: 'ai-zh',
    lanDoc: '中文（AI）',
    url: 'https://x/y'
  });
  const { tracks } = decode(makeWebViewMessage([track]));
  assert.equal(tracks[0].id, 300);
});

test('unknown fields and fixed wire types are skipped', () => {
  const track = concat([
    fieldFixed(4, 8), // unknown fixed64 on the track message
    fieldVarint(1, 7),
    fieldString(3, 'ai-zh'),
    fieldFixed(6, 4), // unknown fixed32
    fieldString(5, 'https://x/y'),
    fieldBytes(9, [0xde, 0xad]) // unknown length-delimited
  ]);
  const data = concat([fieldBytes(3, track), fieldVarint(2, 1)]); // unknown data-level field too
  const message = concat([fieldBytes(1, data)]);
  const { tracks } = decode(message);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].lan, 'ai-zh');
  assert.equal(tracks[0].url, 'https://x/y');
});

test('tracks without lan or url are dropped', () => {
  const noLan = concat([fieldVarint(1, 1), fieldString(5, 'https://x/y')]);
  const noUrl = concat([fieldVarint(1, 2), fieldString(3, 'ai-zh')]);
  const good = makeTrackMessage({ id: 3, lan: 'en', lanDoc: 'English', url: 'https://x/z' });
  const { empty, tracks } = decode(makeWebViewMessage([noLan, good, noUrl]));
  assert.equal(empty, false);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].lan, 'en');
});

test('corrupt track message is skipped, others survive', () => {
  const truncated = new Uint8Array(makeTrackMessage({
    id: 1, lan: 'ai-zh', lanDoc: 'x', url: 'https://x/y'
  })).slice(0, 8); // cuts the lan/url fields mid-length
  const good = makeTrackMessage({ id: 2, lan: 'en', lanDoc: 'English', url: 'https://x/z' });
  const { tracks } = decode(makeWebViewMessage([truncated, good]));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].lan, 'en');
});

test('empty protobuf data message (anonymous response) reports empty', () => {
  const { empty, tracks } = decode(Uint8Array.from([0x0a, 0x00]));
  assert.equal(empty, true);
  assert.deepEqual([...tracks], []);
});

test('completely empty payload reports empty', () => {
  const { empty, tracks } = decode(new Uint8Array(0));
  assert.equal(empty, true);
  assert.deepEqual([...tracks], []);
});

test('truncated message throws (no silent corruption)', () => {
  const full = new Uint8Array(makeWebViewMessage([
    makeTrackMessage({ id: 1, lan: 'ai-zh', lanDoc: 'x', url: 'https://x/y' })
  ]));
  const truncated = full.slice(0, full.length - 3);
  assert.throws(() => BS.protobuf.decodeWebViewTracks(truncated));
});

test('unsupported wire type (group start) throws', () => {
  const bad = Uint8Array.from([0x0b]); // field 1, wire type 3 (start group)
  assert.throws(() => BS.protobuf.decodeMessage(bad));
});
