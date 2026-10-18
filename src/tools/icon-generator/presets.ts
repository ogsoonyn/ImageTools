/* アイコン一括生成の出力の定義(DOM に触れない純粋な処理): プリセット・設定・マニフェスト・HTML スニペット */

// path は ZIP 内のパス。ico は 1 ファイルに入れるサイズの一覧
// opaque: 透過できない出力(背景色で塗る) / noRadius: OS 側で角を丸めるので角丸を付けない / maskable: 中央 80% の大きさに縮める(OS のマスクで確実に残るのは中央の直径 80% の円の内側)
export type Item = { path: string; size?: number; ico?: number[]; opaque?: boolean; noRadius?: boolean; maskable?: boolean };
export type PresetId = "web" | "ios" | "android" | "windows";
export type Group = { id: string; label: string };
export type Preset = Group & { id: PresetId; desc: string; items: Item[] };

// 出力プリセット
export const PRESETS: Preset[] = [
  { id: "web", label: "Web(favicon 一式)", desc: "favicon.ico、apple-touch-icon、Android Chrome 用 192/512、maskable、site.webmanifest、HTML スニペット", items: [
    { path: "web/favicon.ico", ico: [16, 32, 48] },
    { path: "web/favicon-16x16.png", size: 16 },
    { path: "web/favicon-32x32.png", size: 32 },
    { path: "web/apple-touch-icon.png", size: 180, opaque: true, noRadius: true },
    { path: "web/android-chrome-192x192.png", size: 192 },
    { path: "web/android-chrome-512x512.png", size: 512 },
    { path: "web/maskable-icon-512x512.png", size: 512, opaque: true, noRadius: true, maskable: true },
  ] },
  { id: "ios", label: "iOS アプリ", desc: "Xcode 用 AppIcon.appiconset(1024px 1 枚 + Contents.json)", items: [
    { path: "ios/AppIcon.appiconset/AppIcon-1024.png", size: 1024, opaque: true, noRadius: true },
  ] },
  { id: "android", label: "Android アプリ", desc: "mipmap 各密度の ic_launcher.png と Play ストア用 512px", items: [
    { path: "android/res/mipmap-mdpi/ic_launcher.png", size: 48 },
    { path: "android/res/mipmap-hdpi/ic_launcher.png", size: 72 },
    { path: "android/res/mipmap-xhdpi/ic_launcher.png", size: 96 },
    { path: "android/res/mipmap-xxhdpi/ic_launcher.png", size: 144 },
    { path: "android/res/mipmap-xxxhdpi/ic_launcher.png", size: 192 },
    { path: "android/play-store-512.png", size: 512 },
  ] },
  { id: "windows", label: "Windows(.ico)", desc: "16〜256px を 1 つにまとめた app.ico", items: [
    { path: "windows/app.ico", ico: [16, 24, 32, 48, 64, 128, 256] },
  ] },
];

export type Bg = "transparent" | "color";
export type ScaleMode = "smooth" | "nearest";
export type Settings = {
  presets: Record<PresetId, boolean>;
  custom: string; pad: number; radius: number; bg: Bg; bgColor: string; scale: ScaleMode;
  appName: string; shortName: string; themeColor: string;
};
export const DEFAULTS: Settings = {
  presets: { web: true, ios: true, android: true, windows: true },
  custom: "", pad: 0, radius: 0, bg: "transparent", bgColor: "#ffffff", scale: "smooth",
  appName: "My App", shortName: "App", themeColor: "#0d7f86",
};

// 保存された値は壊れていることもあるので、使える値か確かめてから使う
export function sanitizeSettings(saved: Record<string, unknown>): Settings {
  const s = structuredClone(DEFAULTS);
  const hex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
  const presets = saved.presets as Record<string, unknown> | null | undefined;
  if (presets && typeof presets === "object") for (const p of PRESETS) if (typeof presets[p.id] === "boolean") s.presets[p.id] = presets[p.id] as boolean;
  if (typeof saved.custom === "string") s.custom = saved.custom.slice(0, 200);
  if (Number.isFinite(saved.pad)) s.pad = Math.min(30, Math.max(0, saved.pad as number));
  if (Number.isFinite(saved.radius)) s.radius = Math.min(50, Math.max(0, saved.radius as number));
  if (saved.bg === "transparent" || saved.bg === "color") s.bg = saved.bg;
  if (saved.scale === "smooth" || saved.scale === "nearest") s.scale = saved.scale;
  for (const k of ["bgColor", "themeColor"] as const) { const v = saved[k]; if (hex(v)) s[k] = v; }
  for (const k of ["appName", "shortName"] as const) { const v = saved[k]; if (typeof v === "string") s[k] = v.slice(0, 100); }
  return s;
}

export function parseCustom(text: string): number[] {
  const out: number[] = [];
  for (const t of String(text).split(/[\s,、]+/)) {
    if (!t) continue;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= 4096 && !out.includes(n)) out.push(n);
  }
  return out;
}

// 選ばれているプリセットとカスタムサイズから、出力するアイコンを並べる
export function activeItems(S: Settings): { group: Group; item: Item }[] {
  const list: { group: Group; item: Item }[] = [];
  for (const p of PRESETS) if (S.presets[p.id]) for (const item of p.items) list.push({ group: p, item });
  const custom = parseCustom(S.custom);
  if (custom.length) {
    const group = { id: "custom", label: "カスタム" };
    for (const s of custom) list.push({ group, item: { path: "custom/icon-" + s + "x" + s + ".png", size: s } });
  }
  return list;
}

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function webManifest(S: Settings): string {
  return JSON.stringify({
    name: S.appName, short_name: S.shortName,
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
      { src: "/maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    theme_color: S.themeColor, background_color: S.bgColor, display: "standalone",
  }, null, 2) + "\n";
}
export function headSnippet(S: Settings): string {
  return [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<meta name="theme-color" content="' + S.themeColor + '">',
  ].join("\n") + "\n";
}
export const IOS_CONTENTS = JSON.stringify({
  images: [{ filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
  info: { author: "xcode", version: 1 },
}, null, 2) + "\n";
