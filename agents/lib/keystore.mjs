// OutLayer keystore pieces for sealed jobs (docs/interface.md section 6.2): the secrets
// profile, the access rule, the coordinator's encryption key, and ECIES v1, the format of
// outlayer-cli src/crypto.rs (verified on outlayer.testnet): X25519, HKDF-SHA256 with info
// "outlayer-keystore-v1" and no salt, ChaCha20-Poly1305 without AAD, wire
// 0x01 | ephemeral public key(32) | nonce(12) | ciphertext | tag(16), base64.

import crypto from "node:crypto";
import { aeadOpen, aeadSeal, publicFromSecret } from "../../judge-wasm/scripts/sealed.mjs";
import { KEYSTORE_PUBKEY_URL, USER_AGENT } from "./config.mjs";

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const ECIES_INFO = Buffer.from("outlayer-keystore-v1", "utf8");
const HEX64 = /^[0-9a-f]{64}$/;

function x25519(secret32, public32) {
  return crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, secret32]), format: "der", type: "pkcs8" }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, public32]), format: "der", type: "spki" }),
  });
}
const eciesKey = (shared) => Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), ECIES_INFO, 32));

/** Encrypt `plaintext` to the keystore's X25519 key. `rng(n)` supplies the ephemeral key and nonce. */
export function eciesEncrypt(recipientPkHex, plaintext, rng) {
  if (!HEX64.test(recipientPkHex)) throw new Error("the keystore key must be 64 lowercase hex characters");
  const ephSecret = rng(32);
  const nonce = rng(12);
  const key = eciesKey(x25519(ephSecret, Buffer.from(recipientPkHex, "hex")));
  const sealed = aeadSeal(key, nonce, Buffer.from(plaintext, "utf8"));
  return Buffer.concat([Buffer.from([0x01]), publicFromSecret(ephSecret), nonce, sealed]).toString("base64");
}

/** The keystore side (used by tests): open an ECIES v1 payload with the recipient's secret. */
export function eciesDecrypt(recipientSecret32, payloadB64) {
  const raw = Buffer.from(payloadB64, "base64");
  if (raw.length < 1 + 32 + 12 + 16 || raw[0] !== 0x01) throw new Error("not an ECIES v1 payload");
  const key = eciesKey(x25519(recipientSecret32, raw.subarray(1, 33)));
  return aeadOpen(key, raw.subarray(33, 45), raw.subarray(45)).toString("utf8");
}

/** `jn-<first 16 hex of sha256(escrow account id)>-<job id>` (section 6.2). */
export function secretsProfile(escrow, jobId) {
  return `jn-${crypto.createHash("sha256").update(escrow, "utf8").digest("hex").slice(0, 16)}-${jobId}`;
}

/** Only this judge build, run because the escrow asked, may read the secret. */
export function accessRule(judgeHash, escrow) {
  return {
    Logic: {
      operator: "And",
      conditions: [{ WasmHash: { hash: judgeHash } }, { Predecessor: { condition: { Whitelist: { accounts: [escrow] } } } }],
    },
  };
}

/** The coordinator's X25519 key for this accessor, owner and profile (POST /secrets/pubkey). */
export async function fetchKeystorePubkey(fetchFn, { judgeHash, owner, profile }) {
  const res = await fetchFn(KEYSTORE_PUBKEY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ accessor: { type: "WasmHash", hash: judgeHash }, owner, profile, secrets_json: "{}" }),
  });
  if (!res.ok) throw new Error(`the keystore pubkey request failed: HTTP ${res.status}`);
  const { pubkey } = await res.json();
  if (typeof pubkey !== "string" || !HEX64.test(pubkey)) throw new Error("the keystore returned a malformed pubkey");
  return pubkey;
}
