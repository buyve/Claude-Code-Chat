import { describe, test, expect } from "bun:test";
import { generateChallenge, signChallenge, verifySignature, loadOrGenerateKey, fingerprint } from "../src/shared/crypto.ts";

describe("crypto", () => {
  test("loadOrGenerateKey returns paths and public key", () => {
    const key = loadOrGenerateKey();
    expect(key.privatePath).toContain("ccc_ed25519");
    expect(key.publicKey).toMatch(/BEGIN PUBLIC KEY/);
  });

  test("sign + verify roundtrip succeeds", () => {
    const key = loadOrGenerateKey();
    const challenge = generateChallenge();
    const sig = signChallenge(challenge, key.privatePath);
    const ok = verifySignature(challenge, sig, key.publicKey);
    expect(ok).toBe(true);
  });

  test("bad signature is rejected", () => {
    const key = loadOrGenerateKey();
    const challenge = generateChallenge();
    // Sign a different challenge
    const otherChallenge = generateChallenge();
    const sig = signChallenge(otherChallenge, key.privatePath);
    const ok = verifySignature(challenge, sig, key.publicKey);
    expect(ok).toBe(false);
  });

  test("fingerprint is deterministic", () => {
    const key = loadOrGenerateKey();
    const fp1 = fingerprint(key.publicKey);
    const fp2 = fingerprint(key.publicKey);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);
  });
});
