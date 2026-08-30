/*
 * Minimal MD5 (RFC 1321) over UTF-8 bytes, used only for WBI signing.
 *
 * Web Crypto intentionally does not provide MD5 and the project avoids
 * runtime dependencies, so this is a compact self-contained implementation.
 * The round constants are hardcoded from the RFC: generating K[i] via
 * Math.sin() is engine-precision-dependent (observed off-by-1-ulp at i=49
 * in V8), which would silently produce wrong digests.
 */

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

function hexLE(word) {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

function md5Bytes(bytes) {
  const len = bytes.length;
  const paddedLen = ((len + 9 + 63) >> 6) << 6;
  const words = new Int32Array(paddedLen >> 2);
  for (let i = 0; i < len; i++) {
    words[i >> 2] |= bytes[i] << ((i & 3) << 3);
  }
  words[len >> 2] |= 0x80 << ((len & 3) << 3);
  words[words.length - 2] = len << 3;
  words[words.length - 1] = Math.floor(len / 536870912); // bit length >> 32

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  for (let block = 0; block < words.length; block += 16) {
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      F = (F + A + K[i] + words[block + g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, SHIFTS[(i >> 4) * 4 + (i & 3)])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}

function md5(text) {
  return md5Bytes(new TextEncoder().encode(String(text)));
}

BS.md5 = md5;
