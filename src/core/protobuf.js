/*
 * Minimal protobuf wire-format decoder for /x/v2/subtitle/web/view.
 *
 * Protocol basis (see docs/PROTOCOL.md):
 *   top-level field 1 (length-delimited) = data message
 *   data field 3 (repeated, length-delimited) = subtitle track
 *     track field 1 (varint)            = id
 *     track field 2 (string)            = id_str
 *     track field 3 (string)            = lan        e.g. "ai-zh" / "zh-Hans"
 *     track field 4 (string)            = lan_doc    display name
 *     track field 5 (string)            = subtitle_url
 *     track field 8 (string)            = label (optional)
 *
 * Unknown fields are skipped, never assumed away. The decoder supports
 * wire types 0 (varint), 1 (64-bit), 2 (length-delimited) and 5 (32-bit);
 * wire types 3/4 (deprecated groups) abort parsing. Varints are accumulated
 * with BigInt so the full unsigned 64-bit wire range stays exact. Values that
 * fit in Number's safe integer range are exposed as numbers; larger values
 * are exposed as decimal strings.
 */

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_FIELD_NUMBER = 0x1fffffffn; // protobuf field numbers: 1..2^29-1

function publicVarint(value) {
  return value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

function readVarint(bytes, offset) {
  let value = 0n;
  let pos = offset;
  for (let index = 0; index < 10; index++) {
    if (pos >= bytes.length) {
      throw new Error(`unterminated varint at ${offset}`);
    }
    const byte = bytes[pos++];
    // An unsigned 64-bit varint has at most one payload bit in byte ten.
    // Checking the complete byte also rejects a continuation bit there.
    if (index === 9 && byte > 0x01) {
      throw new Error(`invalid tenth byte at ${offset}`);
    }
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, offset: pos };
  }
}

function decodeMessage(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const keyValue = key.value;
    const noValue = keyValue >> 3n;
    const wt = Number(keyValue & 7n);
    if (noValue < 1n || noValue > MAX_FIELD_NUMBER) {
      throw new Error(`invalid field number ${noValue}`);
    }
    const no = Number(noValue);

    if (wt === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      fields.push({ no, wt, value: publicVarint(value.value) });
    } else if (wt === 1) {
      const end = offset + 8;
      if (end > bytes.length) throw new Error('truncated 64-bit field');
      fields.push({ no, wt, bytes: bytes.slice(offset, end) });
      offset = end;
    } else if (wt === 2) {
      const len = readVarint(bytes, offset);
      offset = len.offset;
      const length = len.value;
      // Compare while the length is still a BigInt. Only a bounded value is
      // converted to Number for indexing the Uint8Array.
      if (length > BigInt(bytes.length - offset)) {
        throw new Error('truncated length-delimited field');
      }
      const end = offset + Number(length);
      fields.push({ no, wt, bytes: bytes.slice(offset, end) });
      offset = end;
    } else if (wt === 5) {
      const end = offset + 4;
      if (end > bytes.length) throw new Error('truncated 32-bit field');
      fields.push({ no, wt, bytes: bytes.slice(offset, end) });
      offset = end;
    } else {
      throw new Error(`unsupported wire type ${wt}`);
    }
  }
  return fields;
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });

function getString(fields, no) {
  const field = fields.find((f) => f.no === no && f.wt === 2 && f.bytes);
  return field ? textDecoder.decode(field.bytes) : '';
}

function getVarint(fields, no) {
  const field = fields.find((f) => f.no === no && f.wt === 0);
  return field ? field.value : 0;
}

function toTracks(dataFields) {
  const tracks = [];
  for (const field of dataFields) {
    if (field.no !== 3 || field.wt !== 2 || !field.bytes) continue;
    let inner;
    try {
      inner = decodeMessage(field.bytes);
    } catch (e) {
      BS.warn('protobuf: 跳过损坏的轨道字段', e.message);
      continue;
    }
    const lan = getString(inner, 3);
    const url = getString(inner, 5);
    if (!lan || !url) continue;
    const id = getVarint(inner, 1);
    const idStr = getString(inner, 2);
    tracks.push({
      id,
      idStr,
      lan,
      lanDoc: getString(inner, 4),
      url,
      label: getString(inner, 8)
    });
  }
  return tracks;
}

function decodeWebViewTracks(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const top = decodeMessage(bytes);
  const dataField = top.find((f) => f.no === 1 && f.wt === 2 && f.bytes);
  if (!dataField) {
    return { empty: true, tracks: [] };
  }
  const dataFields = decodeMessage(dataField.bytes);
  const tracks = toTracks(dataFields);
  return { empty: tracks.length === 0, tracks };
}

BS.protobuf = { decodeMessage, decodeWebViewTracks };
