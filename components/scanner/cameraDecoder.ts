import { BarcodeDetector, ZXING_WASM_VERSION, prepareZXingModule } from "barcode-detector/ponyfill";

// The decoder is a ~1 MB WebAssembly file. By default the library fetches it from a CDN; we serve our own
// copy instead (put in public/vendor by scripts/copy-zxing-wasm.mjs) so it works offline and without a
// third party. The ?v= query changes with the library version, so the service worker's cached copy
// never goes stale.
export function wasmUrl(): string {
  return `/vendor/zxing_reader.wasm?v=${ZXING_WASM_VERSION}`;
}

let prepared = false;
function prepare() {
  if (prepared) return;
  prepared = true;
  void prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl() : prefix + path),
    },
  });
}

/** A detector for the label formats this app prints: Code 128 (serials, transfer slips) and QR. */
export function createDetector(): BarcodeDetector {
  prepare();
  return new BarcodeDetector({ formats: ["code_128", "qr_code"] });
}

/** Downloads the decoder ahead of time, so the service worker has it for use offline. */
export function warmDecoder(): Promise<Response> {
  return fetch(wasmUrl());
}
