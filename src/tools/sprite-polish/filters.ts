/* シート仕上げのフィルタと背景の透過（DOM に触れない純粋な関数）。絵は ImageData（RGBA） */
import { clonePx, hexRgb } from "./sheet";

export type FilterType = "blur" | "sharpen" | "outline" | "bc" | "hsl" | "posterize" | "replace";
// params: [キー, 名前, 最小, 最大, 刻み, 初期値]、colors: [キー, 名前, 初期値]
type ParamDef = readonly [key: string, name: string, min: number, max: number, step: number, def: number];
type ColorDef = readonly [key: string, name: string, def: string];
type FilterDef = { label: string; params: readonly ParamDef[]; colors?: readonly ColorDef[]; diag?: boolean; noNew?: boolean; keep?: boolean };

export const FDEF: Record<FilterType, FilterDef> = {
  blur: { label: "ぼかし", params: [["r", "半径", 1, 4, 1, 1]], noNew: true, keep: true },
  sharpen: { label: "シャープ", params: [["amt", "強さ", 0.2, 3, 0.1, 1]], noNew: true },
  outline: { label: "アウトライン（外側に足す）", params: [["t", "太さ", 1, 3, 1, 1]], colors: [["oc", "線の色", "#1b1f23"]], diag: true },
  bc: { label: "明るさ・コントラスト", params: [["b", "明るさ", -100, 100, 1, 0], ["c", "コントラスト", -100, 100, 1, 0]], noNew: true },
  hsl: { label: "色相・彩度・明度", params: [["h", "色相", -180, 180, 1, 0], ["s", "彩度", -100, 100, 1, 0], ["l", "明度", -100, 100, 1, 0]], noNew: true },
  posterize: { label: "減色", params: [["n", "色の数", 2, 64, 1, 8]] },
  replace: { label: "色置換", params: [["tol", "許容値", 0, 128, 1, 0]], colors: [["from", "元の色", "#5cba60"], ["to", "新しい色", "#e5484d"]] },
};
export const FHINT: Record<FilterType, string> = {
  blur: "絵をぼかします。「色を増やさない」がオンだと、ぼかした色をシートにある近い色に置き換えるので、ドット絵のまま柔らかくなります。",
  sharpen: "輪郭をくっきりさせます。",
  outline: "絵の外側に線を足します。「斜めも」をオンにすると角まで囲みます。",
  bc: "明るさとコントラストを変えます。",
  hsl: "色相・彩度・明度を変えます。色違いを作るときは「色を増やさない」をオフにします。",
  posterize: "使う色の数を減らします。残す色はシートにある色から選びます。",
  replace: "元の色に近い色（許容値の範囲）を新しい色に置き換えます。色の欄はクリックして選ぶほか、「描く色」で今の描く色を入れられます。",
};

// 掛けるときの値（種類ごとに params・colors のキーを持つ）
export type FilterParams = {
  type: FilterType; noNew: boolean; keep: boolean; diag?: boolean;
  r?: number; amt?: number; t?: number; b?: number; c?: number; h?: number; s?: number; l?: number; n?: number; tol?: number;
  oc?: string; from?: string; to?: string;
};
// [r, g, b, 数]
export type Color4 = [number, number, number, number];
// pal = シートの色（色を増やさないときに寄せる先）、post = 減色で残す色
export type FilterCtx = { pal: Color4[]; post: Color4[] | null };

// シートの色（差分パーツも含む）。[r, g, b, 数]
export function sheetColors(frames: ImageData[]): Color4[] {
  const m = new Map<number, number>();
  for (const px of frames) { const d = px.data; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; m.set(k, (m.get(k) || 0) + 1); } }
  return [...m.entries()].map(([k, n]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, n]);
}
function nearestFn(pal: Color4[]): (r: number, g: number, b: number) => Color4 {
  const memo = new Map<number, Color4>();
  return (r, g, b) => {
    const k = (r << 16) | (g << 8) | b;
    let c = memo.get(k);
    if (!c) { let best = Infinity; for (const p of pal) { const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < best) { best = d; c = p; } } memo.set(k, c!); }
    return c!;
  };
}
// 減色: メディアンカットで箱に分け、箱ごとに一番多い色を残す（シートにある色だけを使う）
export function medianCut(colors: Color4[], n: number): Color4[] {
  let boxes = [colors];
  while (boxes.length < n) {
    let bi = -1, bestR = 0, ax = 0;
    boxes.forEach((b, i) => { if (b.length < 2) return; for (let a = 0; a < 3; a++) { let lo = 255, hi = 0; for (const c of b) { lo = Math.min(lo, c[a]); hi = Math.max(hi, c[a]); } if (hi - lo > bestR) { bestR = hi - lo; bi = i; ax = a; } } });
    if (bi < 0) break;
    const b = boxes[bi].slice().sort((p, q) => p[ax] - q[ax]);
    const total = b.reduce((s, c) => s + c[3], 0); let acc = 0, cut = 1;
    for (let i = 0; i < b.length; i++) { acc += b[i][3]; if (acc >= total / 2) { cut = Math.min(b.length - 1, Math.max(1, i + 1)); break; } }
    boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.map((b) => b.reduce((m, c) => (c[3] > m[3] ? c : m), b[0]));
}
function padded(px: ImageData, P: number): ImageData {
  if (!P) return clonePx(px);
  const n = new ImageData(px.width + 2 * P, px.height + 2 * P);
  for (let y = 0; y < px.height; y++) n.data.set(px.data.subarray(y * px.width * 4, (y + 1) * px.width * 4), ((y + P) * n.width + P) * 4);
  return n;
}
// 乗算済みアルファの箱ぼかし（縦横に分けて掛ける）
function boxBlur(img: ImageData, r: number): Float32Array {
  const { width: w, height: h, data: d } = img, n = w * h;
  let a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const al = d[i * 4 + 3] / 255; a[i * 4] = d[i * 4] * al; a[i * 4 + 1] = d[i * 4 + 1] * al; a[i * 4 + 2] = d[i * 4 + 2] * al; a[i * 4 + 3] = d[i * 4 + 3]; }
  const k = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let ch = 0; ch < 4; ch++) {
      let s = 0;
      for (let t = -r; t <= r; t++) { const xx = pass ? x : x + t, yy = pass ? y + t : y; if (xx >= 0 && yy >= 0 && xx < w && yy < h) s += a[(yy * w + xx) * 4 + ch]; }
      b[(y * w + x) * 4 + ch] = s / k;
    }
    [a, b] = [b, a];
  }
  return a;
}
function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360 / 360;
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
// px にフィルタを掛けた新しい ImageData と、四方に足した余白 P を返す
export function runFilter(px: ImageData, F: FilterParams, ctx: FilterCtx): { img: ImageData; P: number } {
  const t = F.type, P = t === "blur" ? F.r! : t === "outline" ? F.t! : 0;
  const src = padded(px, P), out = clonePx(src), d = out.data, s = src.data, n = out.width * out.height;
  if (t === "blur" || t === "sharpen") {
    const b = boxBlur(src, t === "blur" ? F.r! : 1);
    for (let i = 0; i < n; i++) {
      const o = i * 4, ba = b[o + 3], bm = ba > 0 ? 255 / ba : 0;
      if (t === "blur") {
        if (F.keep && !s[o + 3]) { d[o + 3] = 0; continue; }
        if (ba > 0) { d[o] = b[o] * bm; d[o + 1] = b[o + 1] * bm; d[o + 2] = b[o + 2] * bm; }
        d[o + 3] = F.keep ? s[o + 3] : ba;
      } else if (s[o + 3] && ba > 0) {
        for (let c = 0; c < 3; c++) d[o + c] = s[o + c] + F.amt! * (s[o + c] - b[o + c] * bm);
      }
    }
  } else if (t === "outline") {
    const oc = hexRgb(F.oc!), w = out.width, h = out.height;
    const nb = F.diag ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let k = 0; k < F.t!; k++) {
      const before = new Uint8Array(n); for (let i = 0; i < n; i++) before[i] = d[i * 4 + 3] ? 1 : 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (before[y * w + x]) continue;
        if (nb.some(([ax, ay]) => { const xx = x + ax, yy = y + ay; return xx >= 0 && yy >= 0 && xx < w && yy < h && before[yy * w + xx]; })) d.set(oc, (y * w + x) * 4);
      }
    }
  } else if (t === "bc") {
    const c = (100 + F.c!) / 100, bb = F.b! * 2.55;
    for (let i = 0; i < n * 4; i += 4) if (d[i + 3]) for (let k = 0; k < 3; k++) d[i + k] = (d[i + k] - 128) * c + 128 + bb;
  } else if (t === "hsl") {
    for (let i = 0; i < n * 4; i += 4) if (d[i + 3]) {
      const [h, sa, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
      const ns = Math.max(0, Math.min(1, sa * (1 + F.s! / 100))), nl = Math.max(0, Math.min(1, F.l! >= 0 ? l + (1 - l) * F.l! / 100 : l * (1 + F.l! / 100)));
      const [r, g, b] = hsl2rgb(h + F.h!, ns, nl); d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  } else if (t === "posterize") {
    const near = nearestFn(ctx.post!);
    for (let i = 0; i < n * 4; i += 4) if (d[i + 3]) { const c = near(d[i], d[i + 1], d[i + 2]); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
  } else if (t === "replace") {
    const fr = hexRgb(F.from!), to = hexRgb(F.to!), tol2 = F.tol! * F.tol! * 3;
    for (let i = 0; i < n * 4; i += 4) if (d[i + 3] && (d[i] - fr[0]) ** 2 + (d[i + 1] - fr[1]) ** 2 + (d[i + 2] - fr[2]) ** 2 <= tol2) { d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2]; }
  }
  // 色を増やさない: シートにある近い色に置き換え、半透明はなくす
  if (FDEF[t].noNew && F.noNew && ctx.pal.length) {
    const near = nearestFn(ctx.pal);
    for (let i = 0; i < n * 4; i += 4) {
      if (d[i + 3] < 128) { d[i + 3] = 0; continue; }
      const c = near(d[i], d[i + 1], d[i + 2]); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  return { img: out, P };
}

// 背景を透過する。outer = 外側からつながった所だけ（false なら同じ色をすべて）
export function keyOut(px: ImageData, key: number[], tol: number, outer: boolean): ImageData {
  const n = clonePx(px), d = n.data, w = n.width, h = n.height, tol2 = tol * tol * 3;
  const hit = (i: number) => d[i * 4 + 3] && (d[i * 4] - key[0]) ** 2 + (d[i * 4 + 1] - key[1]) ** 2 + (d[i * 4 + 2] - key[2]) ** 2 <= tol2;
  if (!outer) { for (let i = 0; i < w * h; i++) if (hit(i)) d[i * 4 + 3] = 0; return n; }
  // 外側からつながった所だけ: 端から塗りつぶすように広げる（透明な所も通り道にする）
  const seen = new Uint8Array(w * h), st: number[] = [];
  for (let x = 0; x < w; x++) st.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
  while (st.length) {
    const i = st.pop()!;
    if (seen[i]) continue;
    seen[i] = 1;
    if (!(hit(i) || !d[i * 4 + 3])) continue;
    d[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) st.push(i - 1); if (x < w - 1) st.push(i + 1); if (y > 0) st.push(i - w); if (y < h - 1) st.push(i + w);
  }
  return n;
}
