/* 全ツール共通の JS。各ツールの main.ts から `import { IT } from "@common/it"` で使う */

import { canPickOpen, initSaveDirButton, pickOpen, saveLocal, setLoadedHandle } from "./save";

const PREFIX = "imagetools:";

// ---- localStorage の安全な読み書き（プライベートモード等で例外になっても落ちない） ----
const store = {
  get<T = unknown>(key: string, fallback: T | null = null): T | null {
    try { const v = localStorage.getItem(PREFIX + key); return v === null ? fallback : (JSON.parse(v) as T); }
    catch { return fallback; }
  },
  set(key: string, value: unknown): boolean {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key: string): void {
    try { localStorage.removeItem(PREFIX + key); } catch { /* 無視 */ }
  },
};

// ---- トースト ----
let toastTimer = 0;
function toast(msg: string, ms = 2400): void {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), ms);
}

// ---- テーマ切替（自動 → ライト → ダーク の順に循環） ----
// theme-init は生の文字列で読むため、ここも JSON を介さず同じキーに文字列で保存する
type Theme = "auto" | "light" | "dark";
const THEME_KEY = PREFIX + "theme";
const THEME_LABEL: Record<Theme, string> = { auto: "テーマ: 自動", light: "テーマ: ライト", dark: "テーマ: ダーク" };
function getTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "auto";
}
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* 保存できなくても切替自体は有効 */ }
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = THEME_LABEL[getTheme()];
}
function initThemeToggle(): void {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  btn.textContent = THEME_LABEL[getTheme()];
  btn.addEventListener("click", () => {
    const next = ({ auto: "light", light: "dark", dark: "auto" } as const)[getTheme()];
    applyTheme(next);
    toast(THEME_LABEL[next]);
  });
}

// ---- ファイル保存 ----
// 通常ブラウザ: 保存先フォルダ／保存ダイアログ（Chrome・Edge。save.ts）→ 使えなければ <a download>
// Claude アーティファクト: downloads（"anchor" = 通常ブラウザ / null = downloads が使えない / それ以外 = downloads ハンドル）
type Downloads = { save(arg: { filename: string; data: Blob | string }): Promise<{ status?: string } | undefined> };
declare global {
  interface Window { claude?: { use?: (name: string) => unknown } }
}
let downloadsP: Promise<Downloads | "anchor" | null> | null = null;
function getDownloads(): Promise<Downloads | "anchor" | null> {
  if (!downloadsP) {
    // use は window.claude のメソッドとして呼ぶ（取り出して呼ぶと this が外れる）
    const c = window.claude;
    downloadsP = typeof c?.use === "function"
      ? Promise.resolve().then(() => c.use!("downloads") as Downloads | null).then((d) => d || null, () => null)
      : Promise.resolve("anchor" as const);
  }
  return downloadsP;
}
getDownloads();
const SAVE_ERRORS: Record<string, string> = { declined: "保存をキャンセルしました", rate_limited: "保存が続いたため一時的に制限されています。少し待ってからお試しください" };
async function saveFile(filename: string, data: Blob | string): Promise<boolean> {
  const dl = await getDownloads();
  if (dl === "anchor") {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const r = await saveLocal(filename, blob);
    if (r.status === "saved") { toast(r.where + " を保存しました"); return true; }
    if (r.status === "cancelled") { toast(r.message); return false; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(r.message || filename + " を保存しました", r.message ? 4000 : undefined);
    return true;
  }
  if (!dl) { toast("この表示ではファイルを保存できません"); return false; }
  try {
    const res = await dl.save({ filename, data });
    const ok = !res || res.status === undefined || res.status === "saved";
    if (ok) toast(filename + " を保存しました");
    return ok;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code || "error";
    toast(SAVE_ERRORS[code] || "保存できませんでした（" + code + "）");
    return false;
  }
}
function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type));
}

// ---- ドラッグ&ドロップ受付（ページ全体で受け、zone に .over を付ける） ----
// accept: ファイルを絞る関数（省略時はすべて）。onFiles には絞り込み後の File[] を渡す
// Chrome・Edge では選択欄の代わりにファイル選択ダイアログを開き、ドロップと合わせて読み込んだファイルのハンドルを覚える
// （保存ダイアログを同じフォルダで開くため。save.ts）
type DropOptions = {
  zone: string | HTMLElement | null;
  input?: string | HTMLInputElement | null;
  accept?: (f: File) => boolean;
  onFiles: (files: File[]) => void;
  emptyMessage?: string;
};
function initDrop({ zone, input, accept = () => true, onFiles, emptyMessage = "対応するファイルが見つかりませんでした" }: DropOptions): void {
  const zoneEl = typeof zone === "string" ? document.getElementById(zone) : zone;
  const inputEl = typeof input === "string" ? (document.getElementById(input) as HTMLInputElement | null) : input;
  const handle = (list: FileList | File[] | null | undefined) => {
    const files = [...(list || [])].filter(accept);
    if (!files.length) { toast(emptyMessage); return; }
    onFiles(files);
  };
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth++; zoneEl?.classList.add("over");
  });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zoneEl?.classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; zoneEl?.classList.remove("over");
    // ハンドルはドロップのイベント中にしか取れない
    const handles = [...(e.dataTransfer?.items || [])].filter((i) => i.kind === "file").map((i) => {
      const get = (i as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
      try { return get ? get.call(i).catch(() => null) : null; } catch { return null; }
    });
    const files = [...(e.dataTransfer?.files || [])];
    const first = files.find(accept);
    if (first) Promise.all(handles).then((hs) => setLoadedHandle(hs.find((h) => h?.kind === "file" && h.name === first.name)));
    handle(files);
  });
  if (!inputEl) return;
  inputEl.addEventListener("change", () => { handle(inputEl.files); inputEl.value = ""; });
  let usePicker = canPickOpen;
  // ラベルのクリックも input.click() も、選択欄の click として届く
  inputEl.addEventListener("click", (e) => {
    if (!usePicker) return;
    e.preventDefault();
    pickOpen(inputEl).then((files) => {
      if (files === null) { usePicker = false; toast("もう一度クリックしてファイルを選んでください"); return; }
      if (files.length) handle(files);
    });
  });
}

// ---- ツール間の受け渡し（「○○で開く」） ----
// 送る側: openIn("sprite-polish", [File, ...] か その Promise) で相手のツールを新しいタブに #handoff 付きで開き、
//   準備できた合図が来たらファイルを postMessage で渡す（保存しなくてよい）
//   タブはクリックの中で先に開く（画像の用意を待ってから開くとポップアップとして止められるため）
// 受ける側: 起動時に receive(onFiles, onFail) を呼ぶ。#handoff 付きで開かれたときだけ待ち受けて true を返す
//   （そのときはサンプルの自動読込などを省く）。届かなければ onFail を呼ぶ
const HANDOFF = "imagetools:handoff";
// file:// のページどうしは origin が一致しない（ブラウザにより "file://" か "null"）ので宛先を限定できない
const msgOrigin = () => (location.protocol !== "file:" && location.origin && location.origin !== "null" ? location.origin : "*");
function openIn(tool: string, files: File[] | Promise<File[]>): boolean {
  const win = window.open(tool + ".html#handoff", "_blank");
  const filesP = Promise.resolve(files);
  filesP.catch(() => {}); // 渡す前に失敗・タブを開けなかったときに未処理の reject を出さない
  if (!win) { toast("新しいタブを開けませんでした（ポップアップがブロックされていないか確認してください）", 4000); return false; }
  let timer = 0;
  const onMsg = (e: MessageEvent) => {
    if (e.source !== win || !e.data || e.data.type !== HANDOFF + "-ready") return;
    done();
    filesP.then((files) => win.postMessage({ type: HANDOFF, files }, msgOrigin()), () => toast("渡すデータを作れませんでした"));
  };
  const done = () => { window.removeEventListener("message", onMsg); clearTimeout(timer); };
  timer = window.setTimeout(() => { done(); toast("渡せませんでした。PNG と JSON を保存してから開いてください", 4000); }, 20000);
  window.addEventListener("message", onMsg);
  return true;
}
function receive(onFiles: (files: File[]) => void, onFail?: () => void): boolean {
  if (location.hash !== "#handoff") return false;
  history.replaceState(null, "", location.pathname + location.search);
  const from = window.opener as Window | null;
  if (!from) return false;
  let timer = 0;
  const onMsg = (e: MessageEvent) => {
    if (e.source !== from || !e.data || e.data.type !== HANDOFF) return;
    if (msgOrigin() !== "*" && e.origin !== location.origin) return;
    window.removeEventListener("message", onMsg); clearTimeout(timer);
    const files = [...((e.data.files as unknown[]) || [])].filter((f): f is File => f instanceof File);
    if (files.length) onFiles(files); else if (onFail) onFail();
  };
  window.addEventListener("message", onMsg);
  // 送る側は合図を受けてから大きな PNG を作ることもあるので長めに待つ
  timer = window.setTimeout(() => { window.removeEventListener("message", onMsg); toast("元のツールからデータが届きませんでした"); if (onFail) onFail(); }, 60000);
  from.postMessage({ type: HANDOFF + "-ready" }, msgOrigin());
  return true;
}

initThemeToggle();
initSaveDirButton(toast);
// 別タブでテーマを変えたら追従する（保存はし直さない）
window.addEventListener("storage", (e) => {
  if (e.key !== THEME_KEY) return;
  const t = e.newValue === "light" || e.newValue === "dark" ? e.newValue : null;
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = THEME_LABEL[getTheme()];
});

export const IT = { store, toast, saveFile, canvasToBlob, initDrop, applyTheme, getTheme, openIn, receive };
