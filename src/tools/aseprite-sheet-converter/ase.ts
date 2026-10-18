/* Aseprite (.ase/.aseprite) parser + compositor. Spec: aseprite/docs/ase-file-specs.md
   DOM に触れない処理だけを置く（画面は main.ts） */

export type Header = {
  fileSize: number; frames: number; width: number; height: number; depth: number; flags: number;
  transparentIndex: number; numColors: number; pixelW: number; pixelH: number;
};
export type Layer = {
  index: number; flags: number; type: number; childLevel: number; blendMode: number; opacity: number; name: string;
  tilesetIndex?: number; visible: boolean; background: boolean; reference: boolean; parent: number;
  color?: string; data?: string;
};
export type Cel = {
  frame: number; layer: number; x: number; y: number; opacity: number; type: number; z: number;
  w: number; h: number; link?: number; raw?: Uint8Array; tiles?: Uint8Array; rgba?: Uint8ClampedArray;
  bitsPerTile?: number; idMask: number; xFlip: number; yFlip: number; dFlip: number;
  color?: string; data?: string;
};
export type Frame = { index: number; duration: number; cels: Cel[] };
export type TagDirection = "forward" | "reverse" | "pingpong" | "pingpong_reverse";
export type Tag = { name: string; from: number; to: number; direction: TagDirection; repeat: number; color: string; data?: string };
type Rect = { x: number; y: number; w: number; h: number };
export type SliceKey = { frame: number; bounds: Rect; center?: Rect; pivot?: { x: number; y: number } };
export type Slice = { name: string; color: string; keys: SliceKey[]; data?: string };
type Tileset = {
  id: number; count: number; tw: number; th: number; base: number; name: string; emptyZero: boolean;
  raw?: Uint8Array; rgba?: Uint8ClampedArray; color?: string; data?: string;
};
type Rgba = [number, number, number, number];
export type AseDoc = {
  header: Header; depthName: string; layers: Layer[]; frames: Frame[]; tags: Tag[]; slices: Slice[];
  palette: Rgba[]; warnings: string[];
};
// ユーザーデータ（0x2020）を付ける先。パレットのように付ける先が無いものは空のオブジェクト
type UdTarget = { color?: string; data?: string };

class Reader {
  v: DataView; u8: Uint8Array; p: number;
  constructor(buf: ArrayBuffer) { this.v = new DataView(buf); this.u8 = new Uint8Array(buf); this.p = 0; }
  byte() { return this.v.getUint8(this.p++); }
  word() { const x = this.v.getUint16(this.p, true); this.p += 2; return x; }
  short() { const x = this.v.getInt16(this.p, true); this.p += 2; return x; }
  dword() { const x = this.v.getUint32(this.p, true); this.p += 4; return x; }
  long() { const x = this.v.getInt32(this.p, true); this.p += 4; return x; }
  skip(n: number) { this.p += n; }
  bytes(n: number) { const b = this.u8.subarray(this.p, this.p + n); this.p += n; return b; }
  str() { const n = this.word(); return new TextDecoder().decode(this.bytes(n)); }
}

async function inflate(bytes: Uint8Array<ArrayBuffer>) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const BLEND_NAMES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn",
  "hard_light", "soft_light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
  "addition", "subtract", "divide"];
export const TAG_DIRS: TagDirection[] = ["forward", "reverse", "pingpong", "pingpong_reverse"];
const DEPTH_NAMES: Record<number, string> = { 32: "RGBA", 16: "グレースケール", 8: "インデックス" };

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const rgbaHex = (r: number, g: number, b: number, a: number) => "#" + hex2(r) + hex2(g) + hex2(b) + hex2(a);

export async function parse(buf: ArrayBuffer): Promise<AseDoc> {
  const r = new Reader(buf);
  if (buf.byteLength < 128) throw new Error("ファイルが短すぎます（128バイトのヘッダーがありません）。");
  const h = {} as Header;
  h.fileSize = r.dword();
  const magic = r.word();
  if (magic !== 0xA5E0) throw new Error("Asepriteファイルではありません（マジックナンバー不一致: 0x" + magic.toString(16) + "）。");
  h.frames = r.word(); h.width = r.word(); h.height = r.word(); h.depth = r.word();
  h.flags = r.dword(); r.word(); r.skip(8);
  h.transparentIndex = r.byte(); r.skip(3);
  h.numColors = r.word(); h.pixelW = r.byte(); h.pixelH = r.byte();
  r.p = 128;
  if (![32, 16, 8].includes(h.depth)) throw new Error("未対応の色深度です: " + h.depth);

  const layers: Layer[] = [], frames: Frame[] = [], tags: Tag[] = [], slices: Slice[] = [], tilesets: Tileset[] = [];
  const palette: Rgba[] = [];
  let hasNewPalette = false;
  const pending: Promise<void>[] = [];
  const warnings = new Set<string>();
  let udQueue: UdTarget[] = [];

  for (let fi = 0; fi < h.frames; fi++) {
    const start = r.p;
    const frameBytes = r.dword();
    const fmagic = r.word();
    if (fmagic !== 0xF1FA) throw new Error("フレーム" + fi + "のヘッダーが壊れています。");
    const oldN = r.word(); const duration = r.word(); r.skip(2); const newN = r.dword();
    const n = newN === 0 ? oldN : newN;
    const frame: Frame = { index: fi, duration, cels: [] };
    frames.push(frame);
    for (let ci = 0; ci < n; ci++) {
      const cs = r.p; const size = r.dword(); const type = r.word(); const end = cs + size;
      if (size < 6 || end > buf.byteLength) { warnings.add("壊れたチャンクを検出したため読み込みを途中で打ち切りました。"); break; }
      try {
        switch (type) {
          case 0x2004: { // layer
            const L = { index: layers.length } as Layer;
            L.flags = r.word(); L.type = r.word(); L.childLevel = r.word(); r.word(); r.word();
            L.blendMode = r.word(); L.opacity = r.byte(); r.skip(3); L.name = r.str();
            if (L.type === 2) L.tilesetIndex = r.dword();
            if (!(h.flags & 1)) L.opacity = 255;
            L.visible = !!(L.flags & 1); L.background = !!(L.flags & 8); L.reference = !!(L.flags & 64);
            L.parent = -1;
            for (let k = layers.length - 1; k >= 0; k--) {
              if (layers[k].childLevel === L.childLevel - 1 && layers[k].type === 1) { L.parent = k; break; }
              if (layers[k].childLevel < L.childLevel) break;
            }
            layers.push(L); udQueue = [L];
            break;
          }
          case 0x2005: { // cel
            const c = { frame: fi } as Cel;
            c.layer = r.word(); c.x = r.short(); c.y = r.short(); c.opacity = r.byte();
            c.type = r.word(); c.z = r.short(); r.skip(5);
            if (c.type === 0) { c.w = r.word(); c.h = r.word(); c.raw = r.bytes(c.w * c.h * (h.depth / 8)).slice(); }
            else if (c.type === 1) { c.link = r.word(); }
            else if (c.type === 2) {
              c.w = r.word(); c.h = r.word();
              const comp = r.bytes(end - r.p).slice();
              pending.push(inflate(comp).then((d) => { c.raw = d; }));
            } else if (c.type === 3) {
              c.w = r.word(); c.h = r.word(); c.bitsPerTile = r.word();
              c.idMask = r.dword(); c.xFlip = r.dword(); c.yFlip = r.dword(); c.dFlip = r.dword(); r.skip(10);
              const comp = r.bytes(end - r.p).slice();
              pending.push(inflate(comp).then((d) => { c.tiles = d; }));
            }
            frame.cels.push(c); udQueue = [c];
            break;
          }
          case 0x2019: { // new palette
            const size = r.dword(), first = r.dword(), last = r.dword(); r.skip(8);
            if (palette.length < size) palette.length = size;
            for (let i = first; i <= last; i++) {
              const fl = r.word(); palette[i] = [r.byte(), r.byte(), r.byte(), r.byte()];
              if (fl & 1) r.str();
            }
            hasNewPalette = true; udQueue = [{}];
            break;
          }
          case 0x0004: case 0x0011: { // old palette
            if (hasNewPalette) break;
            const packets = r.word(); let idx = 0;
            for (let p = 0; p < packets; p++) {
              idx += r.byte(); let cnt = r.byte(); if (cnt === 0) cnt = 256;
              for (let k = 0; k < cnt; k++, idx++) {
                let cr = r.byte(), cg = r.byte(), cb = r.byte();
                if (type === 0x0011) { cr = Math.round(cr * 255 / 63); cg = Math.round(cg * 255 / 63); cb = Math.round(cb * 255 / 63); }
                palette[idx] = [cr, cg, cb, 255];
              }
            }
            udQueue = [{}];
            break;
          }
          case 0x2018: { // tags
            const cnt = r.word(); r.skip(8);
            const newTags: Tag[] = [];
            for (let t = 0; t < cnt; t++) {
              const from = r.word(), to = r.word(), dir = r.byte(), repeat = r.word(); r.skip(6);
              const cr = r.byte(), cg = r.byte(), cb = r.byte(); r.skip(1);
              const tag: Tag = { name: r.str(), from, to, direction: TAG_DIRS[dir] || "forward", repeat, color: rgbaHex(cr, cg, cb, 255) };
              tags.push(tag); newTags.push(tag);
            }
            udQueue = newTags;
            break;
          }
          case 0x2020: { // user data
            const target = udQueue.shift();
            const fl = r.dword();
            let text: string | null = null, color: string | null = null;
            if (fl & 1) text = r.str();
            if (fl & 2) color = rgbaHex(r.byte(), r.byte(), r.byte(), r.byte());
            if (target) { if (color) target.color = color; if (text) target.data = text; }
            break;
          }
          case 0x2022: { // slice
            const nk = r.dword(), fl = r.dword(); r.dword();
            const s: Slice = { name: r.str(), color: "#0000ffff", keys: [] };
            for (let k = 0; k < nk; k++) {
              const key: SliceKey = { frame: r.dword(), bounds: { x: r.long(), y: r.long(), w: r.dword(), h: r.dword() } };
              if (fl & 1) key.center = { x: r.long(), y: r.long(), w: r.dword(), h: r.dword() };
              if (fl & 2) key.pivot = { x: r.long(), y: r.long() };
              s.keys.push(key);
            }
            slices.push(s); udQueue = [s];
            break;
          }
          case 0x2023: { // tileset
            const ts = { id: r.dword() } as Tileset; const fl = r.dword();
            ts.count = r.dword(); ts.tw = r.word(); ts.th = r.word(); ts.base = r.short(); r.skip(14);
            ts.name = r.str(); ts.emptyZero = !!(fl & 4);
            if (fl & 1) r.skip(8);
            if (fl & 2) {
              const len = r.dword(); const comp = r.bytes(len).slice();
              pending.push(inflate(comp).then((d) => { ts.raw = d; }));
            } else warnings.add("外部ファイル参照のタイルセットは描画できません。");
            tilesets[ts.id] = ts; udQueue = [ts];
            break;
          }
          default: break; // 0x2006 cel extra, 0x2007 color profile, 0x2008 external files, mask, path...
        }
      } catch {
        warnings.add("チャンク 0x" + type.toString(16) + " の読み込みに失敗しました。");
      }
      r.p = end;
    }
    r.p = start + frameBytes;
  }

  await Promise.all(pending);

  // convert pixel data to RGBA
  const toRGBA = (bytes: Uint8Array | undefined, count: number, bg: boolean) => {
    const out = new Uint8ClampedArray(count * 4);
    if (!bytes) return out;
    if (h.depth === 32) out.set(bytes.subarray(0, count * 4));
    else if (h.depth === 16) {
      for (let i = 0; i < count; i++) { const v = bytes[i * 2]; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = bytes[i * 2 + 1]; }
    } else {
      for (let i = 0; i < count; i++) {
        const idx = bytes[i];
        if (idx === h.transparentIndex && !bg) continue;
        const c = palette[idx]; if (!c) continue;
        out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = c[3];
      }
    }
    return out;
  };
  for (const ts of tilesets) if (ts && ts.raw) ts.rgba = toRGBA(ts.raw, ts.tw * ts.th * ts.count, false);

  for (const f of frames) {
    for (const c of f.cels) {
      const L = layers[c.layer]; if (!L) continue;
      if (c.type === 0 || c.type === 2) c.rgba = toRGBA(c.raw, c.w * c.h, L.background);
      else if (c.type === 3) {
        const ts = tilesets[L.tilesetIndex!];
        if (!ts || !ts.rgba) { warnings.add("タイルマップレイヤー「" + L.name + "」のタイルセットが見つかりません。"); continue; }
        const tsRgba = ts.rgba, tiles = c.tiles!;
        const tw = ts.tw, th = ts.th, W = c.w * tw, H = c.h * th;
        const out = new Uint8ClampedArray(W * H * 4);
        const dv = new DataView(tiles.buffer, tiles.byteOffset, tiles.byteLength);
        const bpt = (c.bitsPerTile || 32) / 8;
        for (let ty = 0; ty < c.h; ty++) for (let tx = 0; tx < c.w; tx++) {
          const off = (ty * c.w + tx) * bpt;
          const v = bpt === 4 ? dv.getUint32(off, true) : bpt === 2 ? dv.getUint16(off, true) : dv.getUint8(off);
          const id = v & c.idMask;
          if (id === 0 && ts.emptyZero) continue;
          if (id >= ts.count) continue;
          const fx = !!(v & c.xFlip), fy = !!(v & c.yFlip), fd = !!(v & c.dFlip);
          for (let py = 0; py < th; py++) for (let px = 0; px < tw; px++) {
            let sx = px, sy = py;
            if (fd) { const t = sx; sx = sy; sy = t; }
            if (fx) sx = tw - 1 - sx;
            if (fy) sy = th - 1 - sy;
            const si = ((id * th + sy) * tw + sx) * 4;
            const di = ((ty * th + py) * W + tx * tw + px) * 4;
            out[di] = tsRgba[si]; out[di + 1] = tsRgba[si + 1]; out[di + 2] = tsRgba[si + 2]; out[di + 3] = tsRgba[si + 3];
          }
        }
        c.rgba = out; c.w = W; c.h = H;
      }
      delete c.raw; delete c.tiles;
    }
  }
  // resolve linked cels
  for (const f of frames) {
    for (const c of f.cels) {
      if (c.type !== 1) continue;
      const src = frames[c.link!] && frames[c.link!].cels.find((k) => k.layer === c.layer && k.type !== 1);
      if (src) { c.rgba = src.rgba; c.w = src.w; c.h = src.h; } else warnings.add("リンク先の見つからないリンクセルがあります。");
    }
  }
  for (const L of layers) if (L.blendMode >= BLEND_NAMES.length) warnings.add("未知の合成モードを「通常」として扱いました。");

  return {
    header: h, depthName: DEPTH_NAMES[h.depth], layers, frames, tags, slices, palette,
    warnings: [...warnings],
  };
}

// ---------- compositing ----------
type Rgb = [number, number, number];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sep: Record<number, (b: number, s: number) => number> = {
  1: (b, s) => b * s,
  2: (b, s) => b + s - b * s,
  3: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  4: (b, s) => Math.min(b, s),
  5: (b, s) => Math.max(b, s),
  6: (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  7: (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  8: (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  9: (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  10: (b, s) => Math.abs(b - s),
  11: (b, s) => b + s - 2 * b * s,
  16: (b, s) => Math.min(1, b + s),
  17: (b, s) => Math.max(0, b - s),
  18: (b, s) => (b === 0 ? 0 : b >= s ? 1 : b / s),
};
const lum = (c: Rgb) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clipColor = (c: Rgb): Rgb => {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  return c.map((v) => { if (n < 0) v = l + ((v - l) * l) / (l - n); if (x > 1) v = l + ((v - l) * (1 - l)) / (x - l); return v; }) as Rgb;
};
const setLum = (c: Rgb, l: number) => { const d = l - lum(c); return clipColor(c.map((v) => v + d) as Rgb); };
const sat = (c: Rgb) => Math.max(...c) - Math.min(...c);
const setSat = (c: Rgb, s: number): Rgb => {
  const mx = Math.max(...c), mn = Math.min(...c);
  if (mx <= mn) return [0, 0, 0];
  return c.map((v) => ((v - mn) * s) / (mx - mn)) as Rgb;
};
const nonsep: Record<number, (b: Rgb, s: Rgb) => Rgb> = {
  12: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  13: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  14: (b, s) => setLum(s, lum(b)),
  15: (b, s) => setLum(b, lum(s)),
};

function drawCel(dst: Uint8ClampedArray, W: number, H: number, c: Cel, opacity: number, mode: number) {
  const f = sep[mode], g = nonsep[mode];
  const x0 = Math.max(0, c.x), y0 = Math.max(0, c.y);
  const x1 = Math.min(W, c.x + c.w), y1 = Math.min(H, c.y + c.h);
  const src = c.rgba!;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const si = ((y - c.y) * c.w + (x - c.x)) * 4;
      const sa = (src[si + 3] / 255) * opacity;
      if (sa <= 0) continue;
      const di = (y * W + x) * 4;
      const ba = dst[di + 3] / 255;
      let sr = src[si] / 255, sg = src[si + 1] / 255, sb = src[si + 2] / 255;
      const br = dst[di] / 255, bg = dst[di + 1] / 255, bb = dst[di + 2] / 255;
      if (ba > 0 && (f || g)) {
        let mr: number, mg: number, mb: number;
        if (f) { mr = f(br, sr); mg = f(bg, sg); mb = f(bb, sb); }
        else { [mr, mg, mb] = g([br, bg, bb], [sr, sg, sb]); }
        sr = (1 - ba) * sr + ba * clamp01(mr); sg = (1 - ba) * sg + ba * clamp01(mg); sb = (1 - ba) * sb + ba * clamp01(mb);
      }
      const ra = sa + ba * (1 - sa);
      dst[di] = ((sr * sa + br * ba * (1 - sa)) / ra) * 255;
      dst[di + 1] = ((sg * sa + bg * ba * (1 - sa)) / ra) * 255;
      dst[di + 2] = ((sb * sa + bb * ba * (1 - sa)) / ra) * 255;
      dst[di + 3] = ra * 255;
    }
  }
}

/** enabled: array<boolean> per layer (user toggles). Returns Uint8ClampedArray W*H*4. */
export function composite(doc: AseDoc, frameIndex: number, enabled: boolean[]): Uint8ClampedArray<ArrayBuffer> {
  const { width: W, height: H } = doc.header;
  const dst = new Uint8ClampedArray(W * H * 4);
  const L = doc.layers;
  const drawable = (i: number) => {
    const l = L[i];
    if (!l || l.type === 1 || l.reference) return false;
    for (let k = i; k >= 0; k = L[k].parent) { if (!enabled[k]) return false; }
    return true;
  };
  // group opacity is only meaningful when header flag 2 is set
  const groupOp = !!(doc.header.flags & 2);
  const effOpacity = (i: number) => {
    let o = 1;
    for (let k = i; k >= 0; k = L[k].parent) if (L[k].type !== 1 || groupOp) o *= L[k].opacity / 255;
    return o;
  };
  const cels = doc.frames[frameIndex].cels.filter((c) => c.rgba && drawable(c.layer));
  cels.sort((a, b) => (a.layer + a.z) - (b.layer + b.z) || a.z - b.z);
  for (const c of cels) drawCel(dst, W, H, c, (c.opacity / 255) * effOpacity(c.layer), L[c.layer].blendMode);
  return dst;
}
