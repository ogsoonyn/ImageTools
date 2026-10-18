/* アイコン一括生成のファイル作成(DOM に触れない純粋な処理): アルファなし PNG・ICO・ZIP */

export type Bytes = Uint8Array<ArrayBuffer>;

export async function blobBytes(blob: Blob): Promise<Bytes> { return new Uint8Array(await blob.arrayBuffer()); }

// 透過できない出力は、アルファチャンネルを持たない RGB の PNG で書き出す
// (canvas.toBlob は常に RGBA になり、App Store は App アイコンのアルファチャンネルを拒否するため)
// px は getImageData の RGBA の並び
export async function encodeRgbPng(px: Uint8ClampedArray, w: number, h: number): Promise<Bytes> {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0, o = 0; y < h; y++) {
    raw[o++] = 0; // フィルタなし
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) { raw[o++] = px[i]; raw[o++] = px[i + 1]; raw[o++] = px[i + 2]; }
  }
  const zlib = await blobBytes(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).blob());
  const enc = new TextEncoder();
  const chunk = (type: string, data: Bytes) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(enc.encode(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit, トゥルーカラー(RGB)
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return blobBytes(new Blob([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))]));
}

// PNG を格納した ICO(Windows Vista 以降・主要ブラウザが対応)
export function encodeIco(entries: { size: number; png: Bytes }[]): Bytes {
  const n = entries.length;
  const total = 6 + 16 * n + entries.reduce((s, e) => s + e.png.length, 0);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, n, true);
  let offset = 6 + 16 * n;
  entries.forEach((e, i) => {
    const b = 6 + 16 * i;
    buf[b] = e.size >= 256 ? 0 : e.size;      // 256 は 0 で表す
    buf[b + 1] = e.size >= 256 ? 0 : e.size;
    dv.setUint16(b + 4, 1, true);             // カラープレーン
    dv.setUint16(b + 6, 32, true);            // ビット深度
    dv.setUint32(b + 8, e.png.length, true);
    dv.setUint32(b + 12, offset, true);
    buf.set(e.png, offset);
    offset += e.png.length;
  });
  return buf;
}

// 無圧縮(STORE)の ZIP。PNG はすでに圧縮済みなので、圧縮しなくてもサイズはほぼ変わらない
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function encodeZip(files: { path: string; data: Bytes }[]): Blob {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Bytes[] = [], centrals: Bytes[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data), size = f.data.length;
    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); // UTF-8 ファイル名
    l.setUint16(8, 0, true); l.setUint16(10, time, true); l.setUint16(12, date, true);
    l.setUint32(14, crc, true); l.setUint32(18, size, true); l.setUint32(22, size, true);
    l.setUint16(26, name.length, true); l.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, f.data); centrals.push(ch);
    offset += lh.length + size;
  }
  const cdSize = centrals.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end], { type: "application/zip" });
}
