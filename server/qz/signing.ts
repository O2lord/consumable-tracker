import "server-only";
import { createSign } from "node:crypto";

// Signs the requests the browser sends to QZ Tray (the label printing program on each PC), so QZ Tray can tell
// they come from this app. Once QZ Tray trusts the certificate (scripts/qz/README.md) it can remember "Allow",
// so staff are not asked every time the page loads.
//
// The private key never leaves the server. Set these two environment variables:
//   QZ_PRIVATE_KEY   the private key (PEM). Line breaks may be written as \n.
//   QZ_CERTIFICATE   the matching certificate (PEM), the part QZ Tray trusts.
// Without them the routes answer 404 and the app prints the old way (QZ Tray asks every time).
//
// What gets signed: QZ Tray's browser library does not send the request itself, it sends the SHA-256 hash of it
// (64 hex characters). So this server cannot tell which QZ call it is signing and cannot limit it to printing.
// What protects it is the sign-in check in the route (only staff who may print labels get a signature) and
// the format check below. Keep the private key secret: whoever has it can sign anything for the QZ Tray PCs
// that trust the certificate.

function readPem(name: string): string | null {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  return `${raw.replace(/\\n/g, "\n").trim()}\n`;
}

export function qzCertificate(): string | null {
  return readPem("QZ_CERTIFICATE");
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export type SignResult = { ok: true; signature: string } | { ok: false; status: number; error: string };

export function signQzRequest(message: string): SignResult {
  const key = readPem("QZ_PRIVATE_KEY");
  if (!key || !qzCertificate()) return { ok: false, status: 404, error: "QZ signing is not set up on this server" };
  // Only what QZ Tray's library sends is signed: the hash of a request. Anything else is refused.
  if (!SHA256_HEX.test(message)) return { ok: false, status: 400, error: "Not a QZ Tray request" };

  try {
    const signature = createSign("RSA-SHA512").update(message).sign(key, "base64");
    return { ok: true, signature };
  } catch (err) {
    console.error("QZ signing failed", err);
    return { ok: false, status: 500, error: "Could not sign the request. Check QZ_PRIVATE_KEY." };
  }
}
