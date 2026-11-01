// Independent reference for sealed jobs (docs/interface.md section 6), written with
// Node built-ins only (node:crypto: X25519, HKDF-SHA256, ChaCha20-Poly1305). It shares
// no code with the Rust judge, so the judge's sealed output can be checked against it.
//
// Provider side: makeKey, encryptDeliverable, providerSecretJson.
// Judge side (reference): sealK, the k the judge must emit on a pass.
// Client side: openK (recover K from k with the client's secret key), decryptDeliverable.

import crypto from "node:crypto";

export const K_EPH_INFO = "judge-near-k-eph-v1";
export const K_INFO = "judge-near-k-v1";
export const K_NONCE_INFO = "judge-near-k-nonce-v1";

// Fixed DER wrappers that turn 32 raw bytes into X25519 KeyObjects (RFC 8410).
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

const privateKeyOf = (sk32) =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, sk32]), format: "der", type: "pkcs8" });
const publicKeyOf = (pk32) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, pk32]), format: "der", type: "spki" });

/** X25519 public key (32 bytes) of a 32-byte secret (clamped per RFC 7748). */
export function publicFromSecret(sk32) {
  return crypto.createPublicKey(privateKeyOf(sk32)).export({ type: "spki", format: "der" }).subarray(-32);
}

/** X25519(secret, public). OpenSSL refuses an all-zero result (small-order public key). */
function x25519(sk32, pk32) {
  return crypto.diffieHellman({ privateKey: privateKeyOf(sk32), publicKey: publicKeyOf(pk32) });
}

/** HKDF-SHA256 with no salt (an empty salt is HashLen zeros once HMAC pads it). */
function hkdf(ikm, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), info, length));
}

/** ChaCha20-Poly1305 with empty AAD; returns ciphertext | tag(16). */
export function aeadSeal(key, nonce, plaintext) {
  const c = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

/** Inverse of aeadSeal; throws if the tag does not verify. */
export function aeadOpen(key, nonce, ctAndTag) {
  if (ctAndTag.length < 16) throw new Error("too short");
  const d = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16));
  return Buffer.concat([d.update(ctAndTag.subarray(0, ctAndTag.length - 16)), d.final()]);
}

/** The provider's per-job key K: 32 random bytes. */
export function makeKey() {
  return crypto.randomBytes(32);
}

/** C = base64(nonce(12) | ChaCha20-Poly1305(K, nonce, plaintext) | tag(16)). */
export function encryptDeliverable(K, plaintext, nonce = crypto.randomBytes(12)) {
  return Buffer.concat([nonce, aeadSeal(K, nonce, Buffer.from(plaintext))]).toString("base64");
}

/** The client side, after recovering K: C back to the plaintext bytes. */
export function decryptDeliverable(K, C) {
  const raw = Buffer.from(C, "base64");
  return aeadOpen(K, raw.subarray(0, 12), raw.subarray(12));
}

/** The OutLayer secret the provider stores for the judge (section 6.2). */
export function providerSecretJson(K) {
  return JSON.stringify({ JN_KEY: Buffer.from(K).toString("hex") });
}

const bound = (label, clientPk, ch, dh) =>
  Buffer.concat([Buffer.from(label, "utf8"), clientPk, Buffer.from(ch, "utf8"), Buffer.from(dh, "utf8")]);

/** k = K sealed to client_pk (section 6.3): deterministic, 93 bytes, 124 base64 chars. */
export function sealK(K, clientPkHex, ch, dh) {
  const pk = Buffer.from(clientPkHex, "hex");
  const ephSk = hkdf(K, bound(K_EPH_INFO, pk, ch, dh), 32);
  const shared = x25519(ephSk, pk);
  const sym = hkdf(shared, Buffer.from(K_INFO, "utf8"), 32);
  const nonce = hkdf(K, bound(K_NONCE_INFO, pk, ch, dh), 12);
  const k = Buffer.concat([Buffer.from([0x01]), publicFromSecret(ephSk), nonce, aeadSeal(sym, nonce, Buffer.from(K))]);
  return k.toString("base64");
}

/** The client: open k with its X25519 secret key and recover K (32 bytes). */
export function openK(k, clientSkHex) {
  const raw = Buffer.from(k, "base64");
  if (raw.length !== 93 || raw[0] !== 0x01) throw new Error("not a v1 k");
  const shared = x25519(Buffer.from(clientSkHex, "hex"), raw.subarray(1, 33));
  const sym = hkdf(shared, Buffer.from(K_INFO, "utf8"), 32);
  return aeadOpen(sym, raw.subarray(33, 45), raw.subarray(45));
}
