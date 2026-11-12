'use strict';

const crypto = require('crypto');

/* ---------------- MP4 box helpers ---------------- */

function readBoxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    out.push({ type, start: off, size, header, end: off + size });
    off += size;
  }
  return out;
}

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex',
  'moof', 'traf', 'sinf', 'schi', 'udta', 'skip'
]);
const VIDEO_ENTRIES = new Set(['avc1', 'avc3', 'encv', 'hvc1', 'hev1', 'vvc1', 'vvi1', 'vp09', 'av01', 'mp4v', 'mp4s', 'svc1', 'mvc1']);
const AUDIO_ENTRIES = new Set(['mp4a', 'enca', 'ac-3', 'ec-3', 'ac-4', 'opus', 'fLaC', 'alac', 'sowt', 'twos', 'raw ', 'samr', 'sawb']);
const TEXT_ENTRIES = new Set(['dfxp', 'stpp', 'wvtt', 'metx', 'mett', 'tx3g', 'text', 'sbtl', 'subt']);

function entryContentSkip(type) {
  if (type === 'stsd') return 8;
  if (VIDEO_ENTRIES.has(type)) return 78;
  if (AUDIO_ENTRIES.has(type)) return 28;
  if (TEXT_ENTRIES.has(type)) return 8;
  return 0;
}

function isContainerType(type) {
  return CONTAINERS.has(type) || type === 'stsd' || VIDEO_ENTRIES.has(type) ||
    AUDIO_ENTRIES.has(type) || TEXT_ENTRIES.has(type);
}

/* Walk the whole file collecting every box with parent info. */
function parseTree(buf) {
  const nodes = [];
  function rec(start, end, parent) {
    for (const box of readBoxes(buf, start, end)) {
      const node = { ...box, parent, children: [] };
      if (parent) parent.children.push(node);
      nodes.push(node);
      if (isContainerType(box.type)) {
        let cs = box.start + box.header;
        if (box.type === 'meta') cs += 4;
        rec(cs + entryContentSkip(box.type), box.end, node);
      }
    }
  }
  rec(0, buf.length, null);
  return nodes;
}

/* ---------------- tenc / senc / trun / tfhd parsing ---------------- */

function parseTenc(buf, box) {
  const c = box.start + box.header;
  if (box.size - box.header < 24) return null;
  return {
    version: buf[c],
    cryptByteBlock: buf[c + 4],
    cryptSkipByteBlock: buf[c + 5],
    isProtected: buf[c + 6],
    ivSize: buf[c + 7],
    kid: buf.slice(c + 8, c + 24).toString('hex')
  };
}

function parseSenc(buf, box, ivSize) {
  const c = box.start + box.header;
  const version = buf[c];
  const flags = (buf[c + 1] << 16) | (buf[c + 2] << 8) | buf[c + 3];
  let p = c + 4;
  let sampleCount;
  if (version === 0) { sampleCount = buf.readUInt32BE(p); p += 4; }
  else { sampleCount = Number(buf.readBigUInt64BE(p)); p += 8; }
  const contentEnd = box.end;
  const headerLen = p - c;

  // IV-only variant: no subsample info (seen on audio tracks)
  if (p + sampleCount * ivSize === contentEnd) {
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      samples.push({ iv: buf.slice(p, p + ivSize), subs: [] });
      p += ivSize;
    }
    return samples;
  }

  const samples = [];
  const subsample32 = (flags & 0x1) !== 0;
  for (let i = 0; i < sampleCount; i++) {
    if (p + ivSize + 2 > contentEnd) break;
    const iv = buf.slice(p, p + ivSize); p += ivSize;
    const subsampleCount = buf.readUInt16BE(p); p += 2;
    const subs = [];
    for (let j = 0; j < subsampleCount; j++) {
      if (p + 6 > contentEnd) break;
      // observed on Akamai CENC: 6-byte entries = clear_bytes(u16) + encrypted_bytes(u32)
      subs.push({ clear: buf.readUInt16BE(p), enc: buf.readUInt32BE(p + 2) }); p += 6;
    }
    samples.push({ iv, subs });
  }
  return samples;
}

function parseTfhd(buf, box) {
  const c = box.start + box.header;
  const flags = (buf[c + 1] << 16) | (buf[c + 2] << 8) | buf[c + 3];
  let p = c + 4;
  const trackId = buf.readUInt32BE(p); p += 4;
  let baseDataOffset = null, defDur = null, defSize = null, defFlags = null;
  if (flags & 0x1) { baseDataOffset = Number(buf.readBigUInt64BE(p)); p += 8; }
  if (flags & 0x2) { p += 4; } // sample_description_index
  if (flags & 0x8) { defDur = buf.readUInt32BE(p); p += 4; }
  if (flags & 0x10) { defSize = buf.readUInt32BE(p); p += 4; }
  if (flags & 0x20) { defFlags = buf.readUInt32BE(p); p += 4; }
  return { flags, trackId, baseDataOffset, defDur, defSize, defFlags,
    defaultBaseIsMoof: (flags & 0x020000) !== 0 };
}

function parseTrun(buf, box) {
  const c = box.start + box.header;
  const version = buf[c];
  const flags = (buf[c + 1] << 16) | (buf[c + 2] << 8) | buf[c + 3];
  let p = c + 4;
  const sampleCount = buf.readUInt32BE(p); p += 4;
  let dataOffset = null;
  if (flags & 0x1) { dataOffset = buf.readInt32BE(p); p += 4; }
  if (flags & 0x4) { p += 4; } // first_sample_flags
  const durP = !!(flags & 0x100), sizeP = !!(flags & 0x200), flagsP = !!(flags & 0x400), ctoP = !!(flags & 0x800);
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    let dur = null, size = null;
    if (durP) { dur = buf.readUInt32BE(p); p += 4; }
    if (sizeP) { size = buf.readUInt32BE(p); p += 4; }
    if (flagsP) { p += 4; }
    if (ctoP) { p += 4; }
    samples.push({ dur, size });
  }
  return { version, flags, sampleCount, dataOffset, samples };
}

/* ---------------- AES-128-CTR ---------------- */

// Decrypt `data` (a subarray) which represents `streamOffset` bytes into the
// sample's continuous CTR stream whose IV is `iv16` (16 bytes, BE counter).
function cryptRange(data, streamOffset, key, iv16) {
  if (data.length === 0) return;
  const ecb = crypto.createCipheriv('aes-128-ecb', key, null);
  ecb.setAutoPadding(false);

  const counter = Buffer.from(iv16);
  const blockIdx = Math.floor(streamOffset / 16);
  let inBlock = streamOffset % 16;
  // counter += blockIdx (128-bit BE add)
  let carry = blockIdx;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const v = counter[i] + carry;
    counter[i] = v & 0xff;
    carry = Math.floor(v / 256);
  }

  let pos = 0;
  while (pos < data.length) {
    const ks = ecb.update(counter);
    const n = Math.min(16 - inBlock, data.length - pos);
    for (let i = 0; i < n; i++) data[pos + i] ^= ks[inBlock + i];
    pos += n;
    inBlock += n;
    if (inBlock === 16) {
      inBlock = 0;
      for (let i = 15; i >= 0; i--) {
        counter[i] = (counter[i] + 1) & 0xff;
        if (counter[i] !== 0) break;
      }
    }
  }
}

function ivTo128(ivBytes, mode) {
  const out = Buffer.alloc(16);
  if (ivBytes.length >= 16) { ivBytes.copy(out, 0, 0, 16); return out; }
  if (mode === 'low') ivBytes.copy(out, 16 - ivBytes.length);
  else ivBytes.copy(out, 0);
  return out;
}

/* ---------------- init segment rewrite ---------------- */

// Strip sinf/pssh and rename encv/enca to their clear-lead format.
function decryptInit(initBuf) {
  const nodes = parseTree(initBuf);
  const remove = new Set();
  const renames = [];

  for (const node of nodes) {
    if (node.type === 'sinf' || node.type === 'pssh') remove.add(node);
    if (node.type === 'encv' || node.type === 'enca') {
      const frma = node.children.find((c) => c.type === 'frma');
      let orig = null;
      if (frma && frma.end - frma.start - frma.header >= 4) {
        orig = initBuf.toString('latin1', frma.start + frma.header, frma.start + frma.header + 4);
      }
      renames.push({ offset: node.start + 4, type: orig || (node.type === 'encv' ? 'avc1' : 'mp4a') });
    }
  }

  const buf = Buffer.from(initBuf);
  for (const r of renames) buf.write(r.type, r.offset, 'latin1');

  const ranges = [...remove].map((n) => [n.start, n.end]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else merged.push([s, e]);
  }
  if (!merged.length) return buf;

  const shrink = new Map();
  for (const node of remove) {
    let p = node.parent;
    while (p) { shrink.set(p, (shrink.get(p) || 0) + node.size); p = p.parent; }
  }

  let outLen = buf.length;
  for (const [s, e] of merged) outLen -= e - s;
  const out = Buffer.alloc(outLen);
  let w = 0, cursor = 0;
  for (const [s, e] of merged) {
    buf.copy(out, w, cursor, s);
    w += s - cursor;
    cursor = e;
  }
  buf.copy(out, w, cursor);

  function removedBefore(pos) {
    let total = 0;
    for (const [s, e] of merged) {
      if (s >= pos) break;
      total += Math.min(e, pos) - s;
    }
    return total;
  }
  for (const [node, delta] of shrink) {
    const newStart = node.start - removedBefore(node.start);
    const newSize = node.size - delta;
    if (node.header === 16) out.writeBigUInt64BE(BigInt(newSize), newStart + 8);
    else out.writeUInt32BE(newSize, newStart);
  }
  return out;
}

/* ---------------- media segment decryption ---------------- */

// opts: { ivMode:'low'|'high', counterMode:'continuous'|'reset', subsampleOrder:'ce'|'ec' }
function decryptSegment(segBuf, keyHex, opts = {}) {
  const { ivMode = 'low', counterMode = 'continuous', subsampleOrder = 'ce', coverRemainder = true } = opts;
  const key = Buffer.from(keyHex, 'hex');
  const nodes = parseTree(segBuf);

  let ivSize = 8;
  for (const n of nodes) {
    if (n.type === 'tenc') {
      const t = parseTenc(segBuf, n);
      if (t && t.ivSize > 0 && t.ivSize <= 16) { ivSize = t.ivSize; break; }
    }
  }

  const topMoofs = nodes.filter((n) => n.type === 'moof' && n.parent === null);
  for (const moof of topMoofs) {
    for (const traf of moof.children.filter((c) => c.type === 'traf')) {
      const tfhd = traf.children.find((c) => c.type === 'tfhd');
      const trun = traf.children.find((c) => c.type === 'trun');
      const senc = traf.children.find((c) => c.type === 'senc');
      if (!tfhd || !trun || !senc) continue;

      const tf = parseTfhd(segBuf, tfhd);
      const tr = parseTrun(segBuf, trun);
      const sencSamples = parseSenc(segBuf, senc, ivSize);

      const base = tf.defaultBaseIsMoof ? moof.start : (tf.baseDataOffset != null ? tf.baseDataOffset : 0);
      let dataPos = base + (tr.dataOffset || 0);
      const count = Math.min(tr.samples.length, sencSamples.length);

      for (let i = 0; i < count; i++) {
        const s = tr.samples[i];
        const size = s.size != null ? s.size : (tf.defSize || 0);
        const sampleStart = dataPos;
        const sampleEnd = dataPos + size;
        dataPos = sampleEnd;
        if (!size) continue;

        const sEnc = sencSamples[i];
        const iv16 = ivTo128(sEnc.iv, ivMode);
        const subs = sEnc.subs;

        // build encrypted ranges + their CTR stream offsets
        const ranges = [];
        if (subs.length === 0) {
          ranges.push({ start: sampleStart, len: size, streamPos: 0 });
        } else {
          let cursor = 0, streamPos = 0;
          for (const sub of subs) {
            const clear = sub.clear;
            let enc = sub.enc;
            cursor += clear;
            // clamp: never run past the sample
            if (cursor + enc > size) enc = size - cursor;
            if (enc > 0) {
              ranges.push({ start: sampleStart + cursor, len: enc, streamPos });
              streamPos += enc;
            }
            cursor += enc;
          }
          // if subsamples don't cover the whole sample, treat the remainder as encrypted
          if (coverRemainder && cursor < size && ranges.length) {
            const last = ranges[ranges.length - 1];
            const extra = size - cursor;
            // extend the last encrypted range to the end of the sample
            last.len += extra;
          }
        }

        for (const r of ranges) {
          if (r.start < 0 || r.start + r.len > segBuf.length) continue;
          const off = counterMode === 'reset' ? 0 : r.streamPos;
          cryptRange(segBuf.subarray(r.start, r.start + r.len), off, key, iv16);
        }
      }
    }
  }
  return segBuf;
}

module.exports = { parseTree, readBoxes, parseTenc, parseSenc, parseTfhd, parseTrun, decryptInit, decryptSegment, ivTo128, cryptRange };
