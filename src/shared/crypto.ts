// SSH ed25519 key management and challenge-response signing

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import crypto from "crypto";

const KEY_NAME = "ccc_ed25519";

function sshDir(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
  return join(home, ".ssh");
}

function keyPath(): string {
  return process.env["CCC_KEY_PATH"] ?? join(sshDir(), KEY_NAME);
}

function pubKeyPath(): string {
  const base = process.env["CCC_KEY_PATH"];
  return base ? `${base}.pub` : join(sshDir(), `${KEY_NAME}.pub`);
}

/** Load existing key or generate a new ed25519 keypair for CCC. */
export function loadOrGenerateKey(): { privatePath: string; publicKey: string } {
  const privPath = keyPath();
  const pubPath = pubKeyPath();

  if (!existsSync(privPath) || !existsSync(pubPath)) {
    const dir = sshDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Generate ed25519 keypair using Node crypto (PEM format — portable)
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    writeFileSync(privPath, privateKey, { mode: 0o600 });
    writeFileSync(pubPath, publicKey, { mode: 0o644 });
  }

  const publicKey = readFileSync(pubPath, "utf-8").trim();
  return { privatePath: privPath, publicKey };
}

/** Read the private key as a KeyObject. */
export function readPrivateKey(privatePath: string): crypto.KeyObject {
  const pem = readFileSync(privatePath, "utf-8");
  return crypto.createPrivateKey(pem);
}

/** Read a public key string and return a KeyObject. */
export function readPublicKey(pubKeyStr: string): crypto.KeyObject {
  // If it's already PEM format
  if (pubKeyStr.includes("BEGIN PUBLIC KEY")) {
    return crypto.createPublicKey(pubKeyStr);
  }
  throw new Error("Unsupported public key format");
}

/** Sign a challenge (base64-encoded) with the ed25519 private key. Returns base64 signature. */
export function signChallenge(challenge: string, privatePath: string): string {
  const privateKey = readPrivateKey(privatePath);
  const challengeBuf = Buffer.from(challenge, "base64");
  const sig = crypto.sign(null, challengeBuf, privateKey);
  return sig.toString("base64");
}

/** Verify a signature against a challenge using a PEM public key string. */
export function verifySignature(
  challenge: string,
  signature: string,
  publicKeyStr: string,
): boolean {
  try {
    const pubKey = readPublicKey(publicKeyStr);
    const challengeBuf = Buffer.from(challenge, "base64");
    const sigBuf = Buffer.from(signature, "base64");
    return crypto.verify(null, challengeBuf, pubKey, sigBuf);
  } catch {
    return false;
  }
}

/** Generate a 32-byte random challenge, returned as base64. */
export function generateChallenge(): string {
  return crypto.randomBytes(32).toString("base64");
}

/** Compute fingerprint (SHA-256 hex prefix) from PEM public key. */
export function fingerprint(publicKeyStr: string): string {
  const hash = crypto.createHash("sha256").update(publicKeyStr).digest("hex");
  return hash.slice(0, 16);
}
