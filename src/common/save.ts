/* 保存先の決め方（File System Access API。Chrome / Edge のみ）
   - 保存先フォルダを設定していれば、そのフォルダへダイアログなしで書き込む（フォルダは IndexedDB に記憶し、全ツール共通）
   - 設定していなければ保存ダイアログを開く。最初に開くフォルダは、最後に読み込んだファイルのフォルダ（無ければ前回保存したフォルダ）
   - API が無いブラウザ（Firefox / Safari）や iframe の中では使わず、従来のダウンロード保存にする */

type PermState = "granted" | "denied" | "prompt";
type HandlePerm = { queryPermission?(d: { mode: "readwrite" }): Promise<PermState>; requestPermission?(d: { mode: "readwrite" }): Promise<PermState> };
type PickerType = { description?: string; accept: Record<string, string[]> };
type FsaWindow = Window & {
  showOpenFilePicker?(o: { multiple?: boolean; types?: PickerType[]; id?: string }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o: { suggestedName?: string; types?: PickerType[]; id?: string; startIn?: FileSystemHandle }): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o: { id?: string; mode?: "readwrite"; startIn?: FileSystemHandle }): Promise<FileSystemDirectoryHandle>;
};
const w = window as FsaWindow;
const topLevel = (() => { try { return window.self === window.top; } catch { return false; } })();
/** 保存ダイアログとフォルダ指定が使えるか */
export const canPickSave = topLevel && typeof w.showSaveFilePicker === "function";
export const canPickDir = topLevel && typeof w.showDirectoryPicker === "function";
/** 読み込みを専用ダイアログに切り替えられるか（読み込んだファイルのハンドルを受け取るため） */
export const canPickOpen = topLevel && typeof w.showOpenFilePicker === "function";

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

// ---- 最後に読み込んだファイル（保存ダイアログを同じフォルダで開くため。このページの中だけ覚える） ----
let lastLoaded: FileSystemFileHandle | null = null;
/** ハンドルの無い読み込み（選択欄・ブラウザからのドラッグ・受け渡し）では null を渡して忘れる */
export function setLoadedHandle(h: FileSystemHandle | null | undefined): void {
  lastLoaded = h && h.kind === "file" ? (h as FileSystemFileHandle) : null;
}

// ---- 読み込み: <input type=file> の accept からダイアログの種類を作る ----
const IMAGE_EXTS = [".png", ".apng", ".jpg", ".jpeg", ".jfif", ".gif", ".bmp", ".webp", ".avif", ".svg", ".ico", ".tif", ".tiff"];
const MIME_EXTS: Record<string, string[]> = {
  "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/gif": [".gif"], "image/bmp": [".bmp"],
  "image/webp": [".webp"], "image/svg+xml": [".svg"], "application/json": [".json"],
};
export function pickerTypes(accept: string): PickerType[] | undefined {
  const img = new Set<string>(), other = new Set<string>();
  for (const raw of accept.split(",")) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const exts = t === "image/*" ? IMAGE_EXTS : t.startsWith(".") ? [t] : MIME_EXTS[t] || [];
    for (const x of exts) (IMAGE_EXTS.includes(x) ? img : other).add(x);
  }
  const acc: Record<string, string[]> = {};
  if (img.size) acc["image/*"] = [...img];
  if (other.size) acc["application/octet-stream"] = [...other];
  return Object.keys(acc).length ? [{ description: "対応するファイル", accept: acc }] : undefined;
}
/** ファイルを選ぶ。キャンセルなら []。ダイアログを出せなければ null（呼び出し側で従来の選択欄を使う） */
export async function pickOpen(input: HTMLInputElement): Promise<File[] | null> {
  try {
    const hs = await w.showOpenFilePicker!({ multiple: input.multiple, types: pickerTypes(input.accept), id: "imagetools-open" });
    setLoadedHandle(hs[0]);
    return await Promise.all(hs.map((h) => h.getFile()));
  } catch (e) {
    return isAbort(e) ? [] : null;
  }
}

// ---- 保存先フォルダの記憶（IndexedDB。ハンドルは localStorage に入らない） ----
const DB = "imagetools", STORE = "handles", DIR_KEY = "saveDir";
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  // 開けないまま終わらないことがあっても保存を止めないよう、2 秒で諦める
  return Promise.race([idbRun<T>(mode, fn), new Promise<undefined>((r) => setTimeout(r, 2000))]);
}
function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((res) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB, 1); } catch { res(undefined); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => res(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const r = fn(db.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => { res(r.result as T); db.close(); };
        r.onerror = () => { res(undefined); db.close(); };
      } catch { res(undefined); db.close(); }
    };
  });
}
let saveDir: FileSystemDirectoryHandle | null = null;
let dirTouched = false; // 読み出しより先に設定・解除されたら、遅れて届いた古い値で上書きしない
// 待つのは 2 秒まで。読み出しが遅れて終わったときも、届いた時点で反映する
export const saveDirReady: Promise<void> = canPickDir
  ? Promise.race([
    idbRun<FileSystemDirectoryHandle>("readonly", (s) => s.get(DIR_KEY)).then((h) => { if (!dirTouched) saveDir = h && h.kind === "directory" ? h : null; }),
    new Promise<void>((r) => setTimeout(r, 2000)),
  ])
  : Promise.resolve();
export const getSaveDir = () => saveDir;
export async function chooseSaveDir(): Promise<FileSystemDirectoryHandle | null> {
  let h: FileSystemDirectoryHandle;
  try { h = await w.showDirectoryPicker!({ id: "imagetools-savedir", mode: "readwrite", startIn: saveDir || lastLoaded || undefined }); }
  catch { return null; }
  saveDir = h; dirTouched = true;
  await idb("readwrite", (s) => s.put(h, DIR_KEY));
  return h;
}
export async function clearSaveDir(): Promise<void> {
  saveDir = null; dirTouched = true;
  await idb("readwrite", (s) => s.delete(DIR_KEY));
}

// ---- 保存 ----
/** saved = 保存した / cancelled = 利用者が止めた / fallback = この方法では保存できない（ダウンロード保存に回す） */
export type SaveResult = { status: "saved"; where: string } | { status: "cancelled"; message: string; declined?: boolean } | { status: "fallback"; message?: string };
const SAVE_TYPES: Record<string, PickerType> = {
  png: { description: "PNG 画像", accept: { "image/png": [".png"] } },
  gif: { description: "GIF 画像", accept: { "image/gif": [".gif"] } },
  json: { description: "JSON", accept: { "application/json": [".json"] } },
  zip: { description: "ZIP", accept: { "application/zip": [".zip"] } },
};
async function write(h: FileSystemFileHandle, blob: Blob): Promise<void> {
  const ws = await h.createWritable();
  try { await ws.write(blob); await ws.close(); }
  catch (e) { await ws.abort().catch(() => {}); throw e; }
}
async function writable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const p = dir as unknown as HandlePerm;
  try {
    if (!p.queryPermission) return true;
    if ((await p.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return (await p.requestPermission?.({ mode: "readwrite" })) === "granted";
  } catch { return false; }
}
async function saveToDir(dir: FileSystemDirectoryHandle, filename: string, blob: Blob): Promise<SaveResult | null> {
  if (!(await writable(dir))) return null;
  let exists = false;
  try { await dir.getFileHandle(filename); exists = true; }
  catch (e) {
    const name = (e as { name?: string } | null)?.name;
    // NotFoundError = まだ無い（普通）。TypeMismatchError = 同名のフォルダがある。それ以外はフォルダが消えた等
    if (name === "TypeMismatchError") return { status: "cancelled", message: filename + " と同じ名前のフォルダがあるため保存できません" };
    if (name === "TypeError") return { status: "cancelled", message: filename + " にはファイル名に使えない文字が含まれています" };
    if (name !== "NotFoundError") return null;
  }
  if (exists && !confirm(`${dir.name} に ${filename} がすでにあります。上書きしますか？`)) return { status: "cancelled", message: "保存をキャンセルしました", declined: true };
  try { await write(await dir.getFileHandle(filename, { create: true }), blob); }
  catch { return null; }
  return { status: "saved", where: dir.name + "/" + filename };
}
// ダイアログはクリックの直後（約 5 秒以内）にしか出せない。書き出しの準備が長かったときなどはダウンロードに回す
const NO_GESTURE = "クリックから時間がたって保存ダイアログを出せなかったため、ダウンロードフォルダに保存しました";
const gestureGone = () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === false;
async function saveWithPicker(filename: string, blob: Blob): Promise<SaveResult> {
  if (gestureGone()) return { status: "fallback", message: NO_GESTURE };
  let h: FileSystemFileHandle;
  try {
    const t = SAVE_TYPES[filename.split(".").pop()!.toLowerCase()];
    h = await w.showSaveFilePicker!({ suggestedName: filename, types: t ? [t] : undefined, id: "imagetools-save", startIn: lastLoaded || undefined });
  } catch (e) {
    // キャンセル以外（クリックから時間がたってダイアログを出せない等）はダウンロード保存に回す
    return isAbort(e) ? { status: "cancelled", message: "保存をキャンセルしました" } : { status: "fallback", message: NO_GESTURE };
  }
  try { await write(h, blob); }
  catch { return { status: "cancelled", message: h.name + " を書き込めませんでした" }; }
  return { status: "saved", where: h.name };
}
export async function saveLocal(filename: string, blob: Blob): Promise<SaveResult> {
  await saveDirReady;
  if (saveDir) {
    const r = await saveToDir(saveDir, filename, blob);
    if (r) return r;
    if (!canPickSave) return { status: "fallback", message: `保存先フォルダ（${saveDir.name}）に書き込めないため、ダウンロードとして保存しました` };
    const p = await saveWithPicker(filename, blob);
    return p.status === "fallback" ? { status: "fallback", message: `保存先フォルダ（${saveDir.name}）に書き込めないため、ダウンロードとして保存しました` } : p;
  }
  if (canPickSave) return saveWithPicker(filename, blob);
  return { status: "fallback" };
}
/** 複数のファイルをまとめて保存する。保存先フォルダが未設定ならフォルダを1回だけ選んでもらう（ファイルごとにダイアログを出すと 2 つ目以降が出せないため） */
export async function saveLocalMany(files: { filename: string; blob: Blob }[]): Promise<SaveResult> {
  await saveDirReady;
  let dir = saveDir;
  if (!dir) {
    if (!canPickDir) return { status: "fallback" };
    if (gestureGone()) return { status: "fallback", message: NO_GESTURE };
    try { dir = await w.showDirectoryPicker!({ id: "imagetools-savemany", mode: "readwrite", startIn: lastLoaded || undefined }); }
    catch (e) { return isAbort(e) ? { status: "cancelled", message: "保存をキャンセルしました" } : { status: "fallback", message: NO_GESTURE }; }
  }
  // 上書きを断ったファイルは飛ばして続ける。途中で書けなくなったら、そこまでに保存できた数を伝える
  let saved = 0;
  for (const f of files) {
    const r = await saveToDir(dir, f.filename, f.blob);
    if (r?.status === "saved") { saved++; continue; }
    if (r?.status === "cancelled" && r.declined) continue;
    if (!r && !saved) return { status: "fallback", message: `${dir.name} フォルダに書き込めないため、ダウンロードとして保存しました` };
    const why = r?.status === "cancelled" ? r.message : f.filename + " を書き込めませんでした";
    return { status: "cancelled", message: `${why}（${files.length} 個中 ${saved} 個を保存済み）` };
  }
  if (!saved) return { status: "cancelled", message: "保存をキャンセルしました" };
  return { status: "saved", where: `${saved === files.length ? "" : files.length + " 個中 "}${saved} 個のファイルを「${dir.name}」フォルダ` };
}

// ---- ヘッダーの「保存先」ボタンと設定ダイアログ ----
function label(btn: HTMLButtonElement): void {
  btn.textContent = "保存先: " + (saveDir ? saveDir.name : "毎回選ぶ");
  btn.title = saveDir
    ? `保存ボタンで「${saveDir.name}」フォルダへ直接保存します（全ツール共通）。クリックで変更・解除`
    : "保存のたびにダイアログを開きます（最初は読み込んだファイルのフォルダ）。クリックで保存先フォルダを設定";
}
export function initSaveDirButton(toast: (m: string) => void): void {
  if (!canPickDir) return;
  const theme = document.querySelector<HTMLElement>(".app-header .actions #themeToggle");
  if (!theme) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn btn-ghost"; btn.id = "saveDirBtn";
  label(btn);
  theme.before(btn);
  saveDirReady.then(() => label(btn));

  const dlg = document.createElement("dialog");
  dlg.className = "it-dialog"; dlg.id = "saveDirDialog";
  dlg.setAttribute("aria-labelledby", "saveDirTitle"); dlg.setAttribute("aria-describedby", "saveDirDesc");
  dlg.innerHTML = `<h2 id="saveDirTitle">保存先</h2>
    <p class="hint" id="saveDirDesc">フォルダを設定すると、保存ボタンでそのフォルダへダイアログなしで保存します（同じ名前のファイルがあれば上書きしてよいか確認します）。設定しないときは保存のたびにダイアログを開き、最初は読み込んだファイルのフォルダを表示します。設定は全ツール共通で、このブラウザに記憶します。ダウンロードやデスクトップなどのフォルダそのものは、ブラウザの制限で選べないことがあります（その中に作ったフォルダなら選べます）。</p>
    <p class="text-sm">いまの保存先: <b data-cur></b></p>
    <div class="acts">
      <button class="btn btn-primary" type="button" data-act="pick">フォルダを選ぶ</button>
      <button class="btn" type="button" data-act="clear">設定を解除</button>
      <button class="btn btn-ghost" type="button" data-act="close">閉じる</button>
    </div>`;
  document.body.append(dlg);
  const sync = () => {
    dlg.querySelector("[data-cur]")!.textContent = saveDir ? saveDir.name + " フォルダ" : "未設定（毎回ダイアログで選ぶ）";
    dlg.querySelector<HTMLButtonElement>('[data-act="clear"]')!.disabled = !saveDir;
    label(btn);
  };
  btn.addEventListener("click", async () => { await saveDirReady; sync(); dlg.showModal(); });
  dlg.addEventListener("click", async (e) => {
    // 枠の外（背景）をクリックで閉じる。target だけでは枠の内側の余白と区別できないので位置で見る
    const r = dlg.getBoundingClientRect();
    if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) { dlg.close(); return; }
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") dlg.close();
    else if (act === "pick") { const h = await chooseSaveDir(); sync(); if (h) { dlg.close(); toast(`保存先を「${h.name}」フォルダにしました`); } }
    else if (act === "clear") { await clearSaveDir(); sync(); dlg.close(); toast("保存先の設定を解除しました（毎回ダイアログで選びます）"); }
  });
}
