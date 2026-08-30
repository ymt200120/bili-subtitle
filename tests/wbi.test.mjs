import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc, mockNet } from './load.mjs';

const BS = loadSrc();

/*
 * Trusted vectors:
 *  - MD5: RFC 1321 test suite; UTF-8 vectors and padding-boundary vectors
 *    cross-checked against Node's crypto.createHash('md5').
 *  - WBI: the community protocol reference (bilibili-API-collect) example,
 *    independently re-verified here with node crypto:
 *    mixin_key = ea1db124af3c7062474693fa704f4ff8 and
 *    w_rid     = 8f6f2b5b3d485fe1886cec6a0be8c5d4 for the documented query.
 */

const MD5_VECTORS = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ['中文', 'a7bac2239fcdcb3a067903d8077c4a07'],
  ['五一四', '6662beb70caf55e76156f338703c1f1d'],
  ['x'.repeat(55), '04364420e25c512fd958a70738aa8f72'],
  ['x'.repeat(56), '668a72d5ba17f08e62dabcafad6db14b'],
  ['x'.repeat(64), 'c1bb4f81d892b2d57947682aeb252456'],
  ['a'.repeat(128), 'e510683b3f5ffe4093d021808bc6ff70']
];

for (const [input, expected] of MD5_VECTORS) {
  const label = input.length > 24 ? `md5(${input.length} bytes)` : `md5(${JSON.stringify(input)})`;
  test(`${label} matches the trusted vector`, () => {
    assert.equal(BS.md5(input), expected);
  });
}

const DOC_IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const DOC_SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const DOC_MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

test('getMixinKey permutes img_key+sub_key per the documented table', () => {
  assert.equal(BS.wbi.getMixinKey(DOC_IMG_KEY, DOC_SUB_KEY), DOC_MIXIN_KEY);
});

test('signParams reproduces the documented w_rid vector', () => {
  const { query, wRid } = BS.wbi.signParams(
    { foo: '114', bar: '514', zab: '1919810' },
    DOC_MIXIN_KEY,
    1702204169
  );
  assert.equal(query, 'bar=514&foo=114&wts=1702204169&zab=1919810');
  assert.equal(wRid, '8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('signParams strips !\'()* from values and URL-encodes UTF-8/spaces', () => {
  const { query } = BS.wbi.signParams(
    { foo: 'one one four', bar: '五一四', punct: "a!b'c(d)e*f" },
    DOC_MIXIN_KEY,
    1702204169
  );
  assert.ok(query.includes('bar=%E4%BA%94%E4%B8%80%E5%9B%9B'), query);
  assert.ok(query.includes('foo=one%20one%20four'), query);
  assert.ok(query.includes('punct=abcdef'), query);
  // keys are sorted lexicographically with wts appended last
  assert.ok(query.startsWith('bar='), query);
  assert.ok(query.endsWith('&wts=1702204169'), query);
});

const NAV_RESPONSE = {
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${DOC_IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${DOC_SUB_KEY}.png`
    }
  }
};

const navNet = () => mockNet({ json: { 'x/web-interface/nav': () => NAV_RESPONSE } });

test('wbi keys are fetched from nav even when anonymous (code -101)', async () => {
  BS.wbi.invalidateKeys();
  const net = navNet();
  const keys = await BS.wbi.getKeys(net);
  assert.equal(keys.imgKey, DOC_IMG_KEY);
  assert.equal(keys.subKey, DOC_SUB_KEY);
  assert.equal(keys.mixinKey, DOC_MIXIN_KEY);
});

test('wbi key cache: no repeated nav within TTL, refetch after expiry', async () => {
  BS.wbi.invalidateKeys();
  const net = navNet();
  await BS.wbi.getKeys(net);
  const callsAfterFirst = net.calls.length;
  assert.equal(callsAfterFirst, 1);
  await BS.wbi.getKeys(net);
  assert.equal(net.calls.length, callsAfterFirst, 'must reuse cached keys');
  BS.wbi._state.fetchedAt = Date.now() - 16 * 60 * 1000;
  await BS.wbi.getKeys(net);
  assert.equal(net.calls.length, callsAfterFirst + 1, 'must refetch after TTL');
});

test('wbi key cache: concurrent getKeys share one nav request', async () => {
  BS.wbi.invalidateKeys();
  const net = navNet();
  await Promise.all([BS.wbi.getKeys(net), BS.wbi.getKeys(net)]);
  assert.equal(net.calls.length, 1);
});

test('wbi sign produces wts + w_rid bound to the mixin key', async () => {
  BS.wbi.invalidateKeys();
  const net = navNet();
  const signed = await BS.wbi.sign(net, { aid: 111, cid: 222 }, { wts: 1702204169 });
  assert.equal(signed.wts, 1702204169);
  assert.ok(signed.query.includes('aid=111'), signed.query);
  assert.ok(signed.query.includes('cid=222'), signed.query);
  assert.equal(signed.query, `aid=111&cid=222&wts=1702204169`);
  assert.equal(signed.wRid, BS.md5(signed.query + DOC_MIXIN_KEY));
});
