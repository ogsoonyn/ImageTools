import { cpSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;

// ビルドの入口: トップページと tools/*.html(公開 URL を今と同じにするため、パスもそのまま出力する)
const pages = [
  "index.html",
  ...readdirSync(resolve(root, "tools"))
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => `tools/${name}`),
];

// ツールが実行時に fetch("../samples/...") するサンプルを dist/ にコピーする
function copySamples(): Plugin {
  return {
    name: "imagetools:copy-samples",
    apply: "build",
    closeBundle() {
      cpSync(resolve(root, "samples"), resolve(root, "dist/samples"), { recursive: true });
    },
  };
}

export default defineConfig({
  // 相対パスで出力し、GitHub Pages の /ImageTools/ 配下でもローカルでも同じ dist が動くようにする
  base: "./",
  // public/ は使わない(サンプルは copySamples で配る)
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map((page) => [page.replace(/\.html$/, ""), resolve(root, page)])),
    },
  },
  resolve: {
    // 共通部品はどこからでも "@common/it" のように読める(tsconfig.json の paths と同じ)
    alias: { "@common": resolve(root, "src/common") },
  },
  plugins: [copySamples()],
});
