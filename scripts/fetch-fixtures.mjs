// Downloads the pinned public fixture GLB (Khronos glTF-Sample-Assets,
// SheenChair — © 2020 Wayfair, CC0 1.0) into apps/web/public/fixtures/.
// The upstream commit and expected SHA-256 are pinned; a mismatch fails loudly.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_COMMIT = "edc7c9e67c639d230715049ee31f9a96a6babbbe"; // glTF-Sample-Assets main, pinned
const URL = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${UPSTREAM_COMMIT}/Models/SheenChair/glTF-Binary/SheenChair.glb`;
const EXPECTED_SHA256 = "f0af2a2b102d28d540236306ae19f8fb36842df76bd38cf76f063f9bd2853399";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "public", "fixtures");
const OUT_FILE = join(OUT_DIR, "SheenChair.glb");

mkdirSync(OUT_DIR, { recursive: true });

let bytes;
if (existsSync(OUT_FILE)) {
  bytes = readFileSync(OUT_FILE);
  console.log(`fixtures: ${OUT_FILE} already present (${bytes.byteLength} bytes), verifying hash`);
} else {
  console.log(`fixtures: downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  bytes = new Uint8Array(await res.arrayBuffer());
}

const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`fixtures: sha256 ${sha}`);
if (sha !== EXPECTED_SHA256) {
  throw new Error(`fixtures: SHA-256 mismatch! expected ${EXPECTED_SHA256}, got ${sha}. Refusing to write.`);
}
if (!existsSync(OUT_FILE)) {
  writeFileSync(OUT_FILE, bytes);
  console.log(`fixtures: wrote ${OUT_FILE}`);
}
console.log("fixtures: done (SheenChair.glb is gitignored by the *.glb rule; see apps/web/fixtures/ATTRIBUTION.md)");
