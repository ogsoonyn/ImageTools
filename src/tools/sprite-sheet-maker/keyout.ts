/* スプライトシート作成の画素処理（DOM に触れない純粋な関数）。
   背景の透過・絵の範囲・コマどうしの差分・ファイル名からの分割数の読み取り */

export type Rgb = [number, number, number];
export type Rect = { x: number; y: number; w: number; h: number };
export type BgMode = "none" | "flood" | "all";
export type LumColor = "unpremul" | "white" | "keep";
// 透過の設定。何も透過しないときは null（このとき位置の揃えは使えない）
export type KeyOpts = {
  mode: BgMode; auto: boolean; key: Rgb; tol: number; soft: number; unblend: boolean;
  lum: { black: number; white: number; color: LumColor } | null;
};

export function hexToRgb(h: string): Rgb { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// キーカラーとの距離（RGB 各成分の差の最大値）で透明度を決める。flood は範囲の外周からつながった画素だけを対象にする。
// 境界のぼかし幅の中は、背景色が混ざった分を差し引いて色を戻せる。輝度をアルファにする場合は、そのあと暗い所ほど透明にする
// d は RGBA の画素（その場で書き換える）
export function keyOutPixels(d: Uint8ClampedArray, w: number, h: number, o: KeyOpts): void {
  const [kr, kg, kb] = o.auto ? [d[0], d[1], d[2]] : o.key;
  const lim = o.tol + o.soft;
  const dist = (p: number) => Math.max(Math.abs(d[p] - kr), Math.abs(d[p + 1] - kg), Math.abs(d[p + 2] - kb));
  let target: Uint8Array | null = null;
  if (o.mode === "flood") {
    const t = (target = new Uint8Array(w * h));
    const stack: number[] = [];
    const push = (i: number) => { if (!t[i] && d[i * 4 + 3] > 0 && dist(i * 4) <= lim) { t[i] = 1; stack.push(i); } };
    for (let px = 0; px < w; px++) { push(px); push((h - 1) * w + px); }
    for (let py = 0; py < h; py++) { push(py * w); push(py * w + w - 1); }
    while (stack.length) {
      const i = stack.pop()!, px = i % w;
      if (px > 0) push(i - 1);
      if (px < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
  }
  const keyed = o.mode !== "none", L = o.lum;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    let r = d[p], g = d[p + 1], b = d[p + 2], a = d[p + 3];
    if (!a) continue;
    if (keyed && !(target && !target[i])) {
      const dd = dist(p);
      if (dd <= o.tol) { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; continue; } // 透明部の RGB も 0 にして色にじみを防ぐ
      if (o.soft > 0 && dd < lim) {
        const t = (dd - o.tol) / o.soft;
        if (o.unblend) { r = (r - kr * (1 - t)) / t; g = (g - kg * (1 - t)) / t; b = (b - kb * (1 - t)) / t; }
        a *= t;
      }
    }
    if (L) {
      const v = Math.max(r, g, b);
      if (L.color === "white") r = g = b = 255;
      else if (L.color === "unpremul" && v > 0) { const k = 255 / v; r *= k; g *= k; b *= k; }
      a *= Math.min(1, Math.max(0, (v - L.black) / (L.white - L.black)));
    }
    a = Math.round(a);
    if (a <= 0) { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; continue; }
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = a; // Uint8ClampedArray なので 0〜255 に収まる
  }
}

// 不透明な画素（α > 16）を囲む矩形。ぼかしで残ったごく薄い画素は無視する
export function contentBoxOf(d: Uint8ClampedArray, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, p = 3; y < h; y++) for (let x = 0; x < w; x++, p += 4) {
    if (d[p] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 1 コマ目（base）と見比べ、色が変わったピクセルを囲む矩形を求める。どれも同じなら null。
// 画素はどれも同じ w×h の RGBA
export function changedBox(base: Uint8ClampedArray, others: Iterable<Uint8ClampedArray>, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const TH = 24;
  for (const d of others) {
    for (let y = 0; y < h; y++) {
      let row = y * w * 4;
      for (let x = 0; x < w; x++, row += 4) {
        const diff = Math.abs(d[row] - base[row]) + Math.abs(d[row + 1] - base[row + 1]) + Math.abs(d[row + 2] - base[row + 2]) + Math.abs(d[row + 3] - base[row + 3]);
        if (diff > TH) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// ファイル名の中の最後の「列x行」（各 1〜64。fx_8x4_v2 も可）。シートとして読むときの分割数に使う
export function gridFromName(name: string): { cols: number; rows: number } | null {
  const m = name.replace(/\.[^.]+$/, "").match(/(\d+)\s*[xX×]\s*(\d+)(?!.*\d+\s*[xX×]\s*\d+)/);
  if (!m) return null;
  const c = +m[1], r = +m[2];
  return c >= 1 && c <= 64 && r >= 1 && r <= 64 ? { cols: c, rows: r } : null;
}
export function commonPrefix(a: string[]): string { if (!a.length) return ""; let p = a[0]; for (const t of a) while (!t.startsWith(p)) p = p.slice(0, -1); return p; }
