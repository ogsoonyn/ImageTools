/* コマ整列ツールの画面に依存しない処理: コマ画素の判定・膨張・連結成分のラベリング・読む順の推定・色の変換 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type DetMode = "color" | "alpha";

export const hexToRgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbToHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

// コマ画素なら 1。alpha = 不透明度が tol より大きい、color = 背景色との差（RGB 各成分の最大差）が tol より大きい
export function foreground(data: Uint8ClampedArray, W: number, H: number, det: DetMode, tol: number, bgColor: string): Uint8Array {
  const n = W * H, fg = new Uint8Array(n);
  if (det === "alpha") {
    for (let i = 0; i < n; i++) fg[i] = data[i * 4 + 3] > tol ? 1 : 0;
  } else {
    const [br, bg, bb] = hexToRgb(bgColor);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] < 8) continue;
      const dist = Math.max(Math.abs(data[j] - br), Math.abs(data[j + 1] - bg), Math.abs(data[j + 2] - bb));
      fg[i] = dist > tol ? 1 : 0;
    }
  }
  return fg;
}

// 正方形（チェビシェフ距離 r）の膨張。横→縦の2回、累積和で O(W*H)
export function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H), pre = new Int32Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + src[o + x];
    for (let x = 0; x < W; x++) { const a = Math.max(0, x - r), b = Math.min(W, x + r + 1); tmp[o + x] = pre[b] - pre[a] > 0 ? 1 : 0; }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) pre[y + 1] = pre[y] + tmp[y * W + x];
    for (let y = 0; y < H; y++) { const a = Math.max(0, y - r), b = Math.min(H, y + r + 1); out[y * W + x] = pre[b] - pre[a] > 0 ? 1 : 0; }
  }
  return out;
}

// 連結成分のラベリング（4近傍、Union-Find の2パス）。結果はコマ画素だけにラベルを付ける
export function labelComponents(mask: Uint8Array, fg: Uint8Array, W: number, H: number): { lab: Int32Array; boxes: Box[] } {
  const lab = new Int32Array(W * H).fill(-1);
  const parent: number[] = [];
  const find = (a: number) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const l = x > 0 ? lab[i - 1] : -1, u = y > 0 ? lab[i - W] : -1;
      if (l < 0 && u < 0) { lab[i] = parent.length; parent.push(parent.length); }
      else if (l >= 0 && u >= 0) { const a = find(l), b = find(u); lab[i] = a; if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
      else lab[i] = l >= 0 ? l : u;
    }
  }
  const remap = new Int32Array(parent.length).fill(-1);
  const boxes: Box[] = [];
  for (let i = 0; i < W * H; i++) {
    if (lab[i] < 0) continue;
    if (!fg[i]) { lab[i] = -1; continue; }
    const r = find(lab[i]);
    let k = remap[r];
    const x = i % W, y = (i / W) | 0;
    if (k < 0) { k = remap[r] = boxes.length; boxes.push({ x0: x, y0: y, x1: x, y1: y }); }
    else { const b = boxes[k]; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; }
    lab[i] = k;
  }
  return { lab, boxes };
}

// ---- 並び順（元画像上の位置から読む順を推定する） ----
// axis 方向の範囲が重なるものを帯にまとめる（短い方の半分以上重なれば同じ帯）
export function bands<T extends Rect>(list: T[], axis: "x" | "y"): T[][] {
  const span = axis === "y" ? (f: T) => [f.y, f.y + f.h] : (f: T) => [f.x, f.x + f.w];
  const sorted = [...list].sort((p, q) => span(p)[0] - span(q)[0] || span(p)[1] - span(q)[1]);
  const out: T[][] = []; let cur: T[] | null = null, lo = 0, hi = 0;
  for (const f of sorted) {
    const [s, e] = span(f);
    const ov = Math.min(e, hi) - Math.max(s, lo);
    if (cur && ov >= 0.5 * Math.min(e - s, hi - lo)) { cur.push(f); hi = Math.max(hi, e); }
    else { cur = [f]; out.push(cur); lo = s; hi = e; }
  }
  return out;
}
// rowsFirst: true = 行（上→下）ごとに左→右。行の中で縦に重なって並ぶものは上→下
export function readOrder<T extends Rect>(list: T[], rowsFirst: boolean): T[][] {
  const outer = bands(list, rowsFirst ? "y" : "x");
  return outer.map((b) => bands(b, rowsFirst ? "x" : "y").flatMap((c) => c.sort((p, q) => (rowsFirst ? p.y - q.y : p.x - q.x))));
}

// 同じ名前が続いたら _2, _3… を付けて重ならないようにする
export function uniqNames(list: string[]): string[] {
  const used = new Set<string>();
  return list.map((n) => { let k = n, i = 2; while (used.has(k)) k = n + "_" + (i++); used.add(k); return k; });
}
