/*
 * Test harness: loads src files (the same plain-script modules the build
 * concatenates, minus ui/main) into a node:vm sandbox exposing BS.
 * No dependencies; no network.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packSources } from '../scripts/pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SRC_FILES = [
  'src/00-namespace.js',
  'src/core/log.js',
  'src/core/model.js',
  'src/core/video-url.js',
  'src/core/cues.js',
  'src/core/exporters.js',
  'src/core/diagnostics.js',
  'src/core/md5.js',
  'src/core/wbi.js',
  'src/core/protobuf.js',
  'src/core/net.js',
  'src/core/spa.js',
  'src/resolvers/video-context.js',
  'src/resolvers/legacy.js',
  'src/resolvers/web-view.js',
  'src/resolvers/signed-wbi.js',
  'src/resolvers/player-resource.js',
  'src/resolvers/index.js'
];

export function loadSrc(extra = {}) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    TextDecoder,
    TextEncoder,
    Date,
    ...extra
  };
  vm.createContext(sandbox);
  const code = packSources(
    SRC_FILES.map((file) => ({
      file,
      code: readFileSync(path.join(ROOT, file), 'utf8')
    }))
  );
  return vm.runInContext(
    `(function () {\n'use strict';\n${code}\nreturn BS;\n})()`,
    sandbox
  );
}

/*
 * Protobuf fixture builders (hand-rolled wire format, per docs/PROTOCOL.md).
 */
export function writeVarint(value) {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

export function fieldVarint(no, value) {
  const head = writeVarint(no * 8 + 0);
  return Uint8Array.from([...head, ...writeVarint(value)]);
}

export function fieldBytes(no, bytes) {
  const head = writeVarint(no * 8 + 2);
  const len = writeVarint(bytes.length);
  return Uint8Array.from([...head, ...len, ...bytes]);
}

export function fieldString(no, text) {
  return fieldBytes(no, new TextEncoder().encode(text));
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function makeTrackMessage({ id = 10, lan, lanDoc, url, label }) {
  const parts = [
    fieldVarint(1, id),
    fieldString(2, String(id)),
    fieldString(3, lan),
    fieldString(4, lanDoc),
    fieldString(5, url)
  ];
  if (label) parts.push(fieldString(8, label));
  return concat(parts);
}

export function makeWebViewMessage(tracks) {
  return concat([
    fieldBytes(
      1,
      concat(tracks.map((t) => fieldBytes(3, t)))
    )
  ]);
}

/*
 * Minimal mock network with call log; handlers keyed by url substring.
 */
export function mockNet(handlers = {}) {
  const calls = [];
  const net = {
    calls,
    async getJson(url, opts) {
      calls.push({ kind: 'json', url });
      for (const [match, handler] of Object.entries(handlers.json || {})) {
        if (url.includes(match)) return handler(url, opts);
      }
      throw new Error(`unexpected getJson: ${url}`);
    },
    async getBinary(url, opts) {
      calls.push({ kind: 'binary', url });
      for (const [match, handler] of Object.entries(handlers.binary || {})) {
        if (url.includes(match)) return handler(url, opts);
      }
      throw new Error(`unexpected getBinary: ${url}`);
    }
  };
  return net;
}

export function makeEnv(net, overrides = {}) {
  return {
    net,
    href: 'https://www.bilibili.com/video/BV1BbKw6XEWq?p=1',
    initialState: null,
    getEntries: () => [],
    onUpdate() {},
    onContext() {},
    ...overrides
  };
}

export const VIEW_RESPONSE = {
  code: 0,
  data: {
    bvid: 'BV1BbKw6XEWq',
    aid: 116939846387549,
    title: '完整版测试视频',
    pages: [{ page: 1, part: 'P1', cid: 40065631429 }]
  }
};
