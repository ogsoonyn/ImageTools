/* アニメーションの書き出し（GIF / APNG のエンコーダ。DOM に触れない）。
   list はコマごとの画素（Uint32 = 0xAABBGGRR）、delays はコマごとの表示時間 (ms) */
import { colorDist2, rgbOf, type Px } from "./tween";

// GIF（透明は 0 番。色が 255 を超えたら近い色にまとめる）
export function encodeGIF(list: Px[], w: number, h: number, delays: number[]): Uint8Array<ArrayBuffer> {
  const map = new Map<number, number>(), pal = [0];
  let over = false;
  for (const px of list) for (const c of px) if (c && !map.has(c)) { if (pal.length < 256) { map.set(c, pal.length); pal.push(c); } else over = true; }
  if (over) for (const px of list) for (const c of px) if (c && !map.has(c)) {
    let best = 1, bd = Infinity; for (let k = 1; k < pal.length; k++) { const d = colorDist2(c, pal[k]); if (d < bd) { bd = d; best = k; } }
    map.set(c, best);
  }
  let bits = 1; while ((1 << bits) < pal.length) bits++;
  const size = 1 << bits, out: number[] = [];
  const u16 = (v: number) => out.push(v & 255, (v >> 8) & 255);
  out.push(...[..."GIF89a"].map((ch) => ch.charCodeAt(0)));
  u16(w); u16(h); out.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let k = 0; k < size; k++) { const [r, g, b] = k < pal.length ? rgbOf(pal[k]) : [0, 0, 0]; out.push(r, g, b); }
  out.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((ch) => ch.charCodeAt(0)), 3, 1, 0, 0, 0);
  const minCode = Math.max(2, bits);
  list.forEach((px, fi) => {
    out.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(Math.max(2, Math.round(delays[fi] / 10))); out.push(0, 0);
    out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0);
    const idx = new Uint8Array(px.length); for (let i = 0; i < px.length; i++) idx[i] = px[i] ? map.get(px[i])! : 0;
    const data = lzw(idx, minCode);
    out.push(minCode);
    for (let i = 0; i < data.length; i += 255) { const part = data.subarray(i, i + 255); out.push(part.length); for (const v of part) out.push(v); }
    out.push(0);
  });
  out.push(0x3b);
  return new Uint8Array(out);
}
function lzw(idx: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode, eoi = clear + 1, bytes: number[] = [];
  let codeSize = minCode + 1, next = eoi + 1, clearFlag = false, acc = 0, nbits = 0;
  const dict = new Map<number, number>();
  const emit = (code: number) => {
    acc |= code << nbits; nbits += codeSize;
    while (nbits >= 8) { bytes.push(acc & 255); acc >>>= 8; nbits -= 8; }
    if (clearFlag) { codeSize = minCode + 1; clearFlag = false; }
    else if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
  };
  emit(clear);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = prefix * 256 + k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) dict.set(key, next++);
    else { dict.clear(); next = eoi + 1; clearFlag = true; emit(clear); }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (nbits > 0) bytes.push(acc & 255);
  return new Uint8Array(bytes);
}

// APNG（各コマを zlib で圧縮して fcTL / fdAT に入れる）
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes: Uint8Array) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function zlib(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());
}
export async function encodeAPNG(list: Px[], w: number, h: number, delays: number[]): Promise<Blob> {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  parts.push(chunk("IHDR", ihdr));
  const actl = new Uint8Array(8); new DataView(actl.buffer).setUint32(0, list.length);
  parts.push(chunk("acTL", actl));
  let seq = 0;
  for (let fi = 0; fi < list.length; fi++) {
    const fc = new Uint8Array(26), f = new DataView(fc.buffer);
    f.setUint32(0, seq++); f.setUint32(4, w); f.setUint32(8, h); f.setUint32(12, 0); f.setUint32(16, 0);
    f.setUint16(20, Math.round(delays[fi])); f.setUint16(22, 1000); fc[24] = 1; fc[25] = 0;
    parts.push(chunk("fcTL", fc));
    const raw = new Uint8Array((w * 4 + 1) * h), bytes = new Uint8Array(list[fi].buffer, list[fi].byteOffset, list[fi].byteLength);
    for (let y = 0; y < h; y++) raw.set(bytes.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
    const z = await zlib(raw);
    if (fi === 0) parts.push(chunk("IDAT", z));
    else { const d = new Uint8Array(4 + z.length); new DataView(d.buffer).setUint32(0, seq++); d.set(z, 4); parts.push(chunk("fdAT", d)); }
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  return new Blob(parts, { type: "image/png" });
}
