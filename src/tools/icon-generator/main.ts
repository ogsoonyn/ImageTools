/* アイコン一括生成の画面 */
import { IT } from "@common/it";
import { blobBytes, encodeIco, encodeRgbPng, encodeZip, type Bytes } from "./encode";
import {
  DEFAULTS, IOS_CONTENTS, PRESETS, activeItems, baseName, headSnippet, sanitizeSettings, webManifest,
  type Bg, type Group, type Item, type ScaleMode,
} from "./presets";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const SAMPLE_URL = "../samples/icon/sample-icon.png";
const SETTINGS_KEY = "icon-generator:settings";
const SVG_RASTER = 1024; // SVG はこの大きさ(長辺)でラスタライズしてから縮小する

type Source = { name: string; w: number; h: number; levels: HTMLCanvasElement[] };
type Tile = { key: string; item: Item; size: number; canvas: HTMLCanvasElement };

const S = loadSettings();
let src: Source | null = null; // levels[0] が原寸、以降は半分ずつ縮小したもの
let tiles: Tile[] = [];
let selectedKey: string | null = null;

function loadSettings() {
  return sanitizeSettings((IT.store.get<Record<string, unknown>>(SETTINGS_KEY, {}) || {}) as Record<string, unknown>);
}
function saveSettings() { IT.store.set(SETTINGS_KEY, S); }

// ---- 入力 ----
function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode failed")); };
    img.src = url;
  });
}

async function toCanvas(blob: Blob, name: string) {
  const isSvg = blob.type === "image/svg+xml" || /\.svg$/i.test(name);
  let w: number, h: number, source: HTMLImageElement | ImageBitmap;
  if (isSvg) {
    const img = await loadImageElement(blob);
    source = img;
    // width/height/viewBox のどれも無い SVG はブラウザが 300×150 とみなすので、正方形として扱う
    const sized = /<svg\b[^>]*\s(?:viewBox|width|height)\s*=/i.test(await blob.text());
    w = (sized && img.naturalWidth) || SVG_RASTER; h = (sized && img.naturalHeight) || SVG_RASTER;
    const k = SVG_RASTER / Math.max(w, h);
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
  } else {
    source = await createImageBitmap(blob);
    w = source.width; h = source.height;
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(source, 0, 0, w, h);
  if ("close" in source) source.close();
  return c;
}

// なめらか縮小用に、半分ずつ縮小した画像を用意しておく(一度に大きく縮小するとギザギザになるため)
function buildLevels(base: HTMLCanvasElement) {
  const levels = [base];
  let cur = base;
  while (cur.width > 2 && cur.height > 2 && Math.max(cur.width, cur.height) > 32) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(cur.width / 2)); c.height = Math.max(1, Math.round(cur.height / 2));
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, c.width, c.height);
    levels.push(c); cur = c;
  }
  return levels;
}

let loadSeq = 0; // 読み込みが重なったときは、最後に始めたものだけを採用する
async function setSource(blob: Blob, name: string): Promise<boolean | null> {
  const seq = ++loadSeq;
  let c: HTMLCanvasElement;
  try { c = await toCanvas(blob, name); }
  catch { if (seq !== loadSeq) return null; IT.toast(name + " を読み込めませんでした"); return false; }
  if (seq !== loadSeq) return null; // 後から始めた読み込みに置き換えられた
  src = { name, w: c.width, h: c.height, levels: buildLevels(c) };
  $("srcNote").textContent = name + "(" + c.width + "×" + c.height + ")";
  selectedKey = null;
  renderNow();
  return true;
}

// ---- 描画 ----
function renderIcon(src: Source, size: number, item: Item) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const radius = item.noRadius ? 0 : (S.radius / 100) * size;
  if (radius > 0) { g.save(); g.beginPath(); g.roundRect(0, 0, size, size, radius); g.clip(); }
  if (item.opaque || S.bg === "color") { g.fillStyle = S.bgColor; g.fillRect(0, 0, size, size); }
  let area = size * (1 - 2 * S.pad / 100);
  if (item.maskable) area *= 0.8;
  const k = Math.min(area / src.w, area / src.h);
  const dw = Math.max(1, Math.round(src.w * k)), dh = Math.max(1, Math.round(src.h * k));
  const dx = Math.round((size - dw) / 2), dy = Math.round((size - dh) / 2);
  let img = src.levels[0];
  if (S.scale === "nearest") {
    g.imageSmoothingEnabled = false;
  } else {
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    for (const lv of src.levels) { if (lv.width >= dw && lv.height >= dh) img = lv; else break; }
  }
  g.drawImage(img, dx, dy, dw, dh);
  if (radius > 0) g.restore();
  return c;
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { if (renderQueued) renderNow(); });
}

function renderNow() {
  renderQueued = false;
  syncControls();
  const wrap = $("tilesWrap");
  wrap.textContent = "";
  tiles = [];
  const list = activeItems(S);
  const hasOut = !!src && list.length > 0;
  $btn("btnZip").disabled = !hasOut;
  $("snippetSec").hidden = !src || !S.presets.web;
  updateWarn(list);
  if (!src) { drawBig(undefined); return; }
  if (!list.length) { drawBig(undefined); $("selInfo").textContent = "出力するアイコンを 1 つ以上選んでください"; $btn("btnPng").disabled = true; return; }

  let currentGroup: Group | null = null, grid: HTMLDivElement | null = null;
  for (const { group, item } of list) {
    if (group !== currentGroup || !grid) {
      currentGroup = group;
      const sec = document.createElement("div");
      sec.className = "group";
      const head = document.createElement("div");
      head.className = "group-head";
      const h = document.createElement("h2");
      h.className = "sec-title"; h.textContent = group.label;
      head.append(h);
      grid = document.createElement("div");
      grid.className = "tiles";
      sec.append(head, grid);
      wrap.append(sec);
    }
    for (const size of item.ico || [item.size!]) {
      const key = item.path + "|" + size;
      const canvas = renderIcon(src, size, item);
      tiles.push({ key, item, size, canvas });
      grid.append(makeTile(key, item, size, canvas));
    }
  }
  if (!tiles.some((t) => t.key === selectedKey)) selectedKey = tiles[0].key;
  selectTile(selectedKey!);
  $("snippet").textContent = headSnippet(S);
}

function makeTile(key: string, item: Item, size: number, canvas: HTMLCanvasElement) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "tile"; b.dataset.key = key;
  b.setAttribute("aria-pressed", "false");
  const box = document.createElement("span");
  box.className = "box bg-checker";
  canvas.setAttribute("aria-hidden", "true");
  box.append(canvas);
  const sz = document.createElement("span");
  sz.className = "size"; sz.textContent = size + "px";
  const nm = document.createElement("span");
  nm.className = "name"; nm.textContent = baseName(item.path) + (item.ico ? "(" + size + ")" : "");
  b.append(box, sz, nm);
  b.setAttribute("aria-label", item.path + " " + size + "×" + size);
  b.addEventListener("click", () => selectTile(key));
  return b;
}

function selectTile(key: string) {
  selectedKey = key;
  for (const el of $("tilesWrap").querySelectorAll<HTMLElement>(".tile")) el.setAttribute("aria-pressed", String(el.dataset.key === key));
  const t = tiles.find((x) => x.key === key);
  drawBig(t);
  $btn("btnPng").disabled = !t;
  if (!t) return;
  $("selName").textContent = pngName(t);
  $("bigPreview").setAttribute("aria-label", pngName(t) + " の拡大プレビュー");
  const notes = [t.size + "×" + t.size + " px", "ZIP 内: " + t.item.path];
  if (t.item.maskable) notes.push("maskable: 80% に縮めています。確実に表示されるのは中央の直径 80% の円の内側です");
  else if (t.item.opaque) notes.push("背景色で塗りつぶしています(透過不可)");
  $("selInfo").textContent = notes.join(" · ");
}

function drawBig(t: Tile | undefined) {
  const c = $<HTMLCanvasElement>("bigPreview");
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  if (!t) { $("selName").textContent = "—"; if (!src) $("selInfo").textContent = "元画像を読み込むと、各サイズのアイコンがここに並びます"; return; }
  // 小さいアイコンはドットが見えるように拡大し、大きいものはなめらかに縮小して表示する
  g.imageSmoothingEnabled = !(t.size < c.width && c.width % t.size === 0);
  g.imageSmoothingQuality = "high";
  g.drawImage(t.canvas, 0, 0, c.width, c.height);
}

function updateWarn(list: { item: Item }[]) {
  const msgs: string[] = [];
  if (src) {
    if (src.w !== src.h) msgs.push("正方形ではないため、中央に配置して余白で正方形にしています。");
    // 実際に描く大きさ(余白・maskable の縮小込み)が元画像の長辺を超えるときだけ警告する
    const fit = (item: Item) => Math.max(...(item.ico || [item.size!])) * (1 - 2 * S.pad / 100) * (item.maskable ? 0.8 : 1);
    const max = Math.round(Math.max(0, ...list.map(({ item }) => fit(item))));
    if (max > Math.max(src.w, src.h) && S.scale === "smooth") msgs.push("元画像が " + max + "px より小さいため、大きいサイズは拡大になりぼやけます。ドット絵なら「ドット絵(ニアレスト)」を選んでください。");
  }
  $("srcWarn").textContent = msgs.join(" ");
  $("srcWarn").hidden = !msgs.length;
}

// ---- 書き出し ----
function pngName(t: Tile) {
  const b = baseName(t.item.path);
  return t.item.ico ? b.replace(/\.ico$/i, "") + "-ico-" + t.size + "x" + t.size + ".png" : b;
}

async function pngBytes(t: Tile): Promise<Bytes> {
  if (t.item.opaque && typeof CompressionStream === "function") {
    try {
      const { width: w, height: h } = t.canvas;
      return await encodeRgbPng(t.canvas.getContext("2d")!.getImageData(0, 0, w, h).data, w, h);
    } catch { /* 失敗したら通常の PNG にする */ }
  }
  return blobBytes(await IT.canvasToBlob(t.canvas));
}

async function buildZip() {
  const enc = new TextEncoder();
  const files: { path: string; data: Bytes }[] = [];
  const byPath = new Map<string, { item: Item; frames: Tile[] }>();
  for (const t of tiles) {
    if (!byPath.has(t.item.path)) byPath.set(t.item.path, { item: t.item, frames: [] });
    byPath.get(t.item.path)!.frames.push(t);
  }
  for (const [path, { item, frames }] of byPath) {
    const pngs = await Promise.all(frames.map(async (t) => ({ size: t.size, png: await pngBytes(t) })));
    files.push({ path, data: item.ico ? encodeIco(pngs) : pngs[0].png });
  }
  if (S.presets.web) {
    files.push({ path: "web/site.webmanifest", data: enc.encode(webManifest(S)) });
    files.push({ path: "web/head-snippet.html", data: enc.encode(headSnippet(S)) });
  }
  if (S.presets.ios) files.push({ path: "ios/AppIcon.appiconset/Contents.json", data: enc.encode(IOS_CONTENTS) });
  return encodeZip(files);
}

$("btnZip").addEventListener("click", async () => {
  const b = $btn("btnZip");
  b.disabled = true;
  try { await IT.saveFile("icons.zip", await buildZip()); }
  catch { IT.toast("ZIP を作成できませんでした"); }
  finally { b.disabled = !src || !tiles.length; }
});
$("btnPng").addEventListener("click", async () => {
  const t = tiles.find((x) => x.key === selectedKey);
  if (!t) return;
  try { await IT.saveFile(pngName(t), new Blob([await pngBytes(t)], { type: "image/png" })); }
  catch { IT.toast("PNGを作成できませんでした"); }
});
$("btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(headSnippet(S)); IT.toast("コピーしました"); }
  catch { IT.toast("コピーできませんでした。テキストを選択してコピーしてください"); }
});

// ---- 設定 UI ----
function buildPresetList() {
  const list = $("presetList");
  for (const p of PRESETS) {
    const label = document.createElement("label");
    label.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.className = "checkbox"; cb.id = "preset-" + p.id;
    cb.checked = S.presets[p.id];
    cb.addEventListener("change", () => { S.presets[p.id] = cb.checked; saveSettings(); render(); });
    const txt = document.createElement("span");
    const t = document.createElement("span");
    t.className = "text-sm"; t.textContent = p.label;
    const d = document.createElement("span");
    d.className = "hint"; d.style.display = "block"; d.textContent = p.desc;
    txt.append(t, d);
    label.append(cb, txt);
    list.append(label);
  }
}

function syncControls() {
  $("padVal").textContent = S.pad + "%";
  $("radiusVal").textContent = S.radius + "%";
  for (const b of document.querySelectorAll<HTMLElement>("[data-bg]")) b.setAttribute("aria-pressed", String(b.dataset.bg === S.bg));
  for (const b of document.querySelectorAll<HTMLElement>("[data-scale]")) b.setAttribute("aria-pressed", String(b.dataset.scale === S.scale));
  $("manifestSec").hidden = !S.presets.web;
}

function fillInputs() {
  $in("pad").value = String(S.pad); $in("radius").value = String(S.radius);
  $in("bgColor").value = S.bgColor; $in("themeColor").value = S.themeColor;
  $in("customSizes").value = S.custom; $in("appName").value = S.appName; $in("shortName").value = S.shortName;
  for (const p of PRESETS) $in("preset-" + p.id).checked = S.presets[p.id];
}

function bindInputs() {
  const on = (id: string, ev: string, fn: (v: string) => void) => $(id).addEventListener(ev, () => { fn($in(id).value); saveSettings(); render(); });
  on("pad", "input", (v) => { S.pad = Number(v); });
  on("radius", "input", (v) => { S.radius = Number(v); });
  on("bgColor", "input", (v) => { S.bgColor = v; });
  on("themeColor", "input", (v) => { S.themeColor = v; });
  on("customSizes", "input", (v) => { S.custom = v; });
  on("appName", "input", (v) => { S.appName = v; });
  on("shortName", "input", (v) => { S.shortName = v; });
  for (const b of document.querySelectorAll<HTMLElement>("[data-bg]")) b.addEventListener("click", () => { S.bg = b.dataset.bg as Bg; saveSettings(); render(); });
  for (const b of document.querySelectorAll<HTMLElement>("[data-scale]")) b.addEventListener("click", () => { S.scale = b.dataset.scale as ScaleMode; saveSettings(); render(); });
}

$("btnResetPrefs").addEventListener("click", () => {
  Object.assign(S, structuredClone(DEFAULTS));
  IT.store.remove(SETTINGS_KEY);
  fillInputs();
  render();
  IT.toast("設定をリセットしました");
});

IT.initDrop({
  zone: "drop",
  input: "fileInput",
  accept: (f) => f.type.startsWith("image/") || /\.svg$/i.test(f.name),
  onFiles: (files) => setSource(files[0], files[0].name),
  emptyMessage: "画像ファイルが見つかりませんでした",
});

// サンプルは samples/ から fetch する(file:// では fetch できないためボタンを無効化)
if (location.protocol === "file:") {
  $btn("btnSample").disabled = true;
  $("sampleNote").textContent = "ローカルファイルとして開いているためサンプルは読み込めません(Webサーバー経由で開くと使えます)";
}
$("btnSample").addEventListener("click", async () => {
  const b = $btn("btnSample");
  b.disabled = true; $("sampleNote").textContent = "";
  try {
    const r = await fetch(SAMPLE_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    if ((await setSource(await r.blob(), "sample-icon.png")) === false) throw new Error("decode failed");
  } catch (e) { $("sampleNote").textContent = "サンプルを読み込めませんでした(" + (e as Error).message + ")"; }
  finally { if (location.protocol !== "file:") b.disabled = false; }
});

// 中の状態を見られるようにする（単体 HTML だった頃のグローバル変数と同じ名前）
Object.assign(window, { S });
Object.defineProperty(window, "src", { get: () => src });
Object.defineProperty(window, "tiles", { get: () => tiles });

buildPresetList();
fillInputs();
bindInputs();
render();
