// Copies the barcode decoder (a WebAssembly file) from node_modules into public/vendor, so the app
// serves it itself. The camera scanner needs it, and serving our own copy means it works offline and
// does not depend on a CDN. Runs after every `npm install`, which keeps the copy in step with the
// installed library version.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm");
const to = join(root, "public/vendor/zxing_reader.wasm");

if (!existsSync(from)) {
  // Never fail an install over this; only the camera scanner is affected.
  console.warn("copy-zxing-wasm: zxing_reader.wasm not found, camera scanning will not work until it is installed.");
  process.exit(0);
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
