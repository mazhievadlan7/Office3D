#!/usr/bin/env node
// Vendors CesiumJS' static runtime assets into public/cesium so the browser can
// fetch them same-origin at window.CESIUM_BASE_URL ("/cesium").
//
// CesiumJS (Apache-2.0) ships its Web Workers, textures/decoders (Assets),
// third-party worker deps (ThirdParty) and widget CSS (Widgets) as plain files
// that must be served next to the app. The JS itself is bundled by Next from
// the "cesium" package; only these four folders need to be static assets.
//
// The copy is reproducible from node_modules, so public/cesium is .gitignored
// and this script runs automatically before `dev` and `build` (npm pre-hooks).
// It is idempotent: it skips the copy when the vendored version matches the
// installed one.

import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  let cesiumPkgPath;
  try {
    cesiumPkgPath = require.resolve("cesium/package.json");
  } catch {
    console.warn("[vendor-cesium] 'cesium' is not installed — skipping (run `npm install`).");
    return;
  }
  const cesiumDir = path.dirname(cesiumPkgPath);
  const version = JSON.parse(await readFile(cesiumPkgPath, "utf8")).version;
  const buildDir = path.join(cesiumDir, "Build", "Cesium");
  if (!existsSync(buildDir)) {
    console.warn(`[vendor-cesium] ${buildDir} not found — skipping.`);
    return;
  }

  const outDir = path.join(root, "public", "cesium");
  const stampPath = path.join(outDir, ".version");
  const stamp = `${version}`;
  if (existsSync(stampPath) && (await readFile(stampPath, "utf8")) === stamp) {
    console.log(`[vendor-cesium] public/cesium already at ${version} — nothing to do.`);
    return;
  }

  const folders = ["Workers", "Assets", "ThirdParty", "Widgets"];
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const folder of folders) {
    const from = path.join(buildDir, folder);
    if (!existsSync(from)) {
      console.warn(`[vendor-cesium] missing ${folder} in build — skipping that folder.`);
      continue;
    }
    await cp(from, path.join(outDir, folder), { recursive: true });
  }
  await writeFile(stampPath, stamp, "utf8");
  console.log(`[vendor-cesium] copied Cesium ${version} assets to public/cesium.`);
}

main().catch((error) => {
  console.error("[vendor-cesium] failed:", error);
  process.exitCode = 1;
});
