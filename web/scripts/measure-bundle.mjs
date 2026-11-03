// Production artifact accounting only. Does not estimate browser/network latency.
// Run: npm run build -- --manifest && node scripts/measure-bundle.mjs dist
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
const directory = resolve(process.argv[2] || "dist");
const manifest = JSON.parse(
  readFileSync(resolve(directory, ".vite/manifest.json"), "utf8"),
);
const shell = Object.keys(manifest).find(
  (key) => manifest[key].isEntry && key.endsWith(".html"),
);
if (!shell) throw new Error("Expected built HTML entry in Vite manifest");
function closure(roots) {
  const keys = new Set();
  function visit(key) {
    if (keys.has(key)) return;
    if (!manifest[key]) throw new Error(`Missing manifest entry: ${key}`);
    keys.add(key);
    for (const dependency of manifest[key].imports || []) visit(dependency);
  }
  roots.forEach(visit);
  const js = [
    ...new Set(
      [...keys]
        .map((key) => manifest[key].file)
        .filter((file) => file?.endsWith(".js")),
    ),
  ];
  const css = [...new Set([...keys].flatMap((key) => manifest[key].css || []))];
  function sizes(files) {
    return files.reduce(
      (result, file) => {
        const bytes = readFileSync(resolve(directory, file));
        result.rawBytes += bytes.length;
        result.gzipBytes += gzipSync(bytes).length;
        return result;
      },
      { rawBytes: 0, gzipBytes: 0 },
    );
  }
  return { roots, jsFiles: js, cssFiles: css, js: sizes(js), css: sizes(css) };
}
const entries = { shell: closure([shell]) };
for (const name of [
  "Subscriptions",
  "Sources",
  "Fleet",
  "PublishedRoutes",
  "Admin",
  "ServerRoutes",
  "Profiles",
]) {
  const key = Object.keys(manifest).find((key) => key.endsWith(`/${name}.tsx`));
  // A formerly eager route can be absent as its own manifest entry.
  if (key) entries[name] = closure([shell, key]);
}
console.log(
  JSON.stringify(
    {
      methodology:
        "Production static import closure; shell plus named route. Dynamic imports/fonts/network/CPU excluded. Per-file gzip, no latency estimate.",
      entries,
    },
    null,
    2,
  ),
);
