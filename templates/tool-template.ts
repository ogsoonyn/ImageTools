/* ツール固有のスクリプト(src/tools/<tool-name>/main.ts にコピーして使う。サンプル実装なので置き換える)。
   画像処理などの DOM に触れない処理は、同じフォルダの別ファイルに純粋な関数として分ける */
import { IT } from "@common/it";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = $<HTMLCanvasElement>("preview");
const pctx = preview.getContext("2d")!;
let loaded: { name: string }[] = [];

function drawPlaceholder() {
  pctx.clearRect(0, 0, preview.width, preview.height);
  pctx.fillStyle = "rgba(127,127,127,.35)";
  pctx.fillRect(0, 0, preview.width, preview.height);
}

async function loadImages(files: File[]) {
  const imgs: { name: string; bmp: ImageBitmap }[] = [];
  for (const f of files) {
    try {
      imgs.push({ name: f.name, bmp: await createImageBitmap(f) });
    } catch {
      IT.toast(f.name + " を読み込めませんでした");
    }
  }
  if (!imgs.length) return;
  // サンプル: 横に並べて 1 枚にする
  const W = imgs.reduce((s, i) => s + i.bmp.width, 0);
  const H = Math.max(...imgs.map((i) => i.bmp.height));
  preview.width = W; preview.height = H;
  let x = 0;
  for (const i of imgs) { pctx.drawImage(i.bmp, x, 0); x += i.bmp.width; i.bmp.close(); }
  loaded = imgs.map((i) => ({ name: i.name }));
  $("srcNote").textContent = imgs.length + " 枚を読み込みました（" + W + "×" + H + "）";
  $<HTMLButtonElement>("btnPng").disabled = $<HTMLButtonElement>("btnJson").disabled = false;
  IT.store.set("template:lastCount", imgs.length);
}

IT.initDrop({
  zone: "drop",
  input: "fileInput",
  accept: (f) => f.type.startsWith("image/"),
  onFiles: loadImages,
  emptyMessage: "画像ファイルが見つかりませんでした",
});

$("btnPng").addEventListener("click", async () => {
  try { await IT.saveFile("output.png", await IT.canvasToBlob(preview)); }
  catch { IT.toast("PNGを作成できませんでした"); }
});
$("btnJson").addEventListener("click", () => {
  const json = JSON.stringify({ size: { w: preview.width, h: preview.height }, sources: loaded }, null, 2);
  IT.saveFile("output.json", new Blob([json], { type: "application/json" }));
});

drawPlaceholder();
