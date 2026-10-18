/* シート仕上げのデータと、DOM に触れない処理(名前の扱い・絵の範囲・書き出すシートの組み立て・Aseprite 互換 JSON) */

// コマ = { id, px: ImageData, lx, ly（px の左上。コマ内の座標）, dx, dy（ずらし）, dur(ms), tag（アクション名） }
export type Frame = { id: number; px: ImageData; lx: number; ly: number; dx: number; dy: number; dur: number; tag: string };
export type Pos = { x: number; y: number };
// 表情差分 = { id, name, img: ImageData, lx, ly（img の左上。パーツ内の座標）, at: { コマid: {x, y} } }
export type Variant = { id: number; name: string; img: ImageData; lx: number; ly: number; at: Record<number, Pos> };
export type Box = { x: number; y: number; w: number; h: number };
// 描き換える対象（コマそのもの、または差分パーツを今のコマに貼った位置で見た仮のコマ）
export type PxObj = { id: number; px: ImageData; lx: number; ly: number; dx: number; dy: number; part?: Variant };
// 書き出すシート。シート = { suffix, rows: [{ name, items: [{ f, v }] }] }。1アクション = 1行
export type SheetRow = { name: string; act?: string; items: { f: Frame; v: Variant | null }[] };
export type SheetSet = { suffix: string; rows: SheetRow[] };
export type ExportVar = "rows" | "files" | "base";
export type Layout = { cols: number; rows: number; W: number; H: number };

export function clonePx(px: ImageData): ImageData { return new ImageData(new Uint8ClampedArray(px.data), px.width, px.height); }

// ---- 色 ----
function hex2(n: number): string { return n.toString(16).padStart(2, "0"); }
export function rgbHex(c: ArrayLike<number>): string { return "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]); }
export function hexRgb(h: string): number[] { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255]; }

// ---- 絵の範囲 ----
const bboxCache = new WeakMap<ImageData, Box | null>();
// px の中の不透明な範囲（px 座標）。全部透明なら null
export function bboxOf(px: ImageData): Box | null {
  if (bboxCache.has(px)) return bboxCache.get(px)!;
  const { width: w, height: h, data: d } = px;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const b = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  bboxCache.set(px, b);
  return b;
}
// 絵を書き換えたら覚えている範囲を捨てる
export function forgetBbox(px: ImageData): void { bboxCache.delete(px); }

// ---- 名前 ----
// ファイル名の最後の「列x行」
export function lastGrid(name: string): [number, number] | null {
  const m = [...String(name).matchAll(/(?<!\d)(\d+)\s*[xX×]\s*(\d+)(?!\d)/g)].pop();
  if (!m) return null;
  const c = +m[1], r = +m[2];
  return c >= 1 && r >= 1 && c <= 256 && r <= 256 ? [c, r] : null;
}
export function guessGrid(src: { width: number; height: number }): [number, number] {
  if (src.width % src.height === 0) return [src.width / src.height, 1];
  if (src.height % src.width === 0) return [1, src.height / src.width];
  return [1, 1];
}
export function baseOf(name: string): string {
  return String(name).replace(/\.[a-z0-9]+$/i, "").replace(/[_\-\s]*(?<!\d)\d+\s*[xX×]\s*\d+(?!\d)/g, "").replace(/^[_\-\s]+/, "") || "sprite_sheet";
}
// 「数字x数字」は分割数と読まれるので外す
export function safeName(n: string): string { return String(n).replace(/(?<!\d)\d+\s*[xX×]\s*\d+(?!\d)/g, "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "variant"; }

// ---- 線（ブレゼンハム） ----
export function line(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) { fn(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
}

// ---- 書き出し ----
// アクション名（最初に出てくる順）
export function actionsOf(frames: Frame[]): string[] { const names: string[] = []; for (const f of frames) if (!names.includes(f.tag)) names.push(f.tag); return names; }
// 書き出すシートの一覧。差分が無ければ元の絵だけ
export function exportSetsOf(frames: Frame[], vs: Variant[], exportVar: ExportVar): SheetSet[] {
  const acts = actionsOf(frames);
  const mode = vs.length ? exportVar : "base";
  const rowsOf = (v: Variant | null, rename?: boolean): SheetRow[] => acts
    .filter((n) => !v || frames.some((f) => f.tag === n && v.at[f.id]))
    .map((n) => ({ name: rename && v ? n + "_" + v.name : n, act: n, items: frames.filter((f) => f.tag === n).map((f) => ({ f, v })) }));
  const base = { suffix: "", rows: rowsOf(null) };
  if (mode === "rows") return [{ suffix: "", rows: base.rows.concat(...vs.map((v) => rowsOf(v, true))) }];
  if (mode === "files") return [base, ...vs.map((v) => ({ suffix: "_" + safeName(v.name), rows: rowsOf(v) })).filter((s) => s.rows.length)];
  return [base];
}
// 列数は一番長い行のコマ数
export function layoutOf(set: SheetSet, cw: number, ch: number): Layout {
  const cols = Math.max(1, ...set.rows.map((r) => r.items.length)), rows = set.rows.length;
  return { cols, rows, W: cols * cw, H: rows * ch };
}
// 末尾に _列x行 を付ける（Anim-Editor がファイル名の最後の「数字x数字」を分割数として読む。各64まで）
export function pngNameOf(baseInput: string, set: SheetSet, cw: number, ch: number): string {
  const base = baseOf(baseInput.trim().replace(/\.(png|json)$/i, "") + ".png") + set.suffix;
  const { cols, rows } = layoutOf(set, cw, ch);
  return base + (cols <= 64 && rows <= 64 ? "_" + cols + "x" + rows : "") + ".png";
}
// Aseprite 互換 JSON（配列形式）。アクションは frameTags に、表示時間は duration に入れる
export function asepriteJsonOf(set: SheetSet, cw: number, ch: number, png: string, durOf: (f: Frame) => number, tagDir: Record<string, string> | undefined) {
  const { W, H } = layoutOf(set, cw, ch), base = png.replace(/\.png$/, "");
  const frames: object[] = [], frameTags: { name: string; from: number; to: number; direction: string; color: string }[] = [];
  set.rows.forEach((row, r) => {
    const from = frames.length;
    row.items.forEach((it, i) => frames.push({
      filename: base + " " + frames.length + ".png",
      frame: { x: i * cw, y: r * ch, w: cw, h: ch }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cw, h: ch }, sourceSize: { w: cw, h: ch }, duration: durOf(it.f),
    }));
    frameTags.push({ name: row.name, from, to: frames.length - 1, direction: (tagDir && row.act !== undefined && tagDir[row.act]) || "forward", color: "#000000ff" });
  });
  return { frames, meta: { app: "https://www.aseprite.org/", version: "1.3", image: png, format: "RGBA8888", size: { w: W, h: H }, scale: "1", frameTags, layers: [], slices: [] } };
}
