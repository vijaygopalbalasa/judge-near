// Crypto of sealed jobs as the agents use it (docs/interface.md sections 6.1 to 6.3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptDeliverable, encryptDeliverable, openK, publicFromSecret } from "../../judge-wasm/scripts/sealed.mjs";
import { accessRule, eciesDecrypt, eciesEncrypt, secretsProfile } from "../lib/keystore.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("K, C and dh round trip as section 6.1 defines them", () => {
  for (const text of ["", "a", "Résumé \u{1F600} 中文", "x".repeat(16384)]) {
    const K = crypto.randomBytes(32);
    const plaintext = Buffer.from(text, "utf8");
    const C = encryptDeliverable(K, plaintext, crypto.randomBytes(12));
    const raw = Buffer.from(C, "base64");
    assert.equal(raw.length, 12 + plaintext.length + 16, "nonce | ciphertext | tag");
    assert.equal(raw.toString("base64"), C, "canonical standard base64");
    assert.ok(C.length <= 21884, "at most 21,884 characters");
    assert.deepEqual(decryptDeliverable(K, C), plaintext);
    assert.throws(() => decryptDeliverable(crypto.randomBytes(32), C), "another key must not open it");
    assert.match(sha256hex(plaintext), /^[0-9a-f]{64}$/);
  }
});

test("every k in judge-wasm/vectors/sealed.json opens with the seeded client secret to the seeded K", () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, "judge-wasm", "vectors", "sealed.json"), "utf8"));
  let opened = 0;
  for (const v of vectors) {
    const { k } = JSON.parse(v.expected);
    if (k === undefined) continue;
    assert.equal(openK(k, v.test_client_sk).toString("hex"), v.test_jn_key.toLowerCase(), v.name);
    opened += 1;
  }
  assert.ok(opened >= 10, `only ${opened} vectors carried k`);
});

test("ECIES v1 output decrypts with the recipient key, and with no other", () => {
  const recipient = crypto.randomBytes(32);
  const pub = publicFromSecret(recipient).toString("hex");
  const secret = JSON.stringify({ JN_KEY: crypto.randomBytes(32).toString("hex") });
  const payload = eciesEncrypt(pub, secret, crypto.randomBytes);
  const raw = Buffer.from(payload, "base64");
  assert.equal(raw[0], 0x01, "version byte");
  assert.equal(raw.length, 1 + 32 + 12 + Buffer.byteLength(secret) + 16, "0x01 | eph | nonce | ct | tag");
  assert.equal(eciesDecrypt(recipient, payload), secret);
  assert.throws(() => eciesDecrypt(crypto.randomBytes(32), payload));
  assert.notEqual(eciesEncrypt(pub, secret, crypto.randomBytes), payload, "a fresh ephemeral key each time");
});

test("eciesDecrypt reads the wire format of the encryptor verified on outlayer.testnet", () => {
  // The encryptor of the near-spike vault.mjs that stored a secret on outlayer.testnet,
  // copied verbatim: an independent producer of the same wire format.
  const SPKI = Buffer.from("302a300506032b656e032100", "hex");
  function vaultEncrypt(pubHex, plaintext) {
    const recipient = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pubHex, "hex")]), format: "der", type: "spki" });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
    const shared = crypto.diffieHellman({ privateKey, publicKey: recipient });
    const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("outlayer-keystore-v1"), 32));
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
    const ephRaw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI.length);
    return Buffer.concat([Buffer.from([0x01]), ephRaw, nonce, ct, c.getAuthTag()]).toString("base64");
  }
  const recipient = crypto.randomBytes(32);
  const msg = '{"JN_KEY":"' + "ab".repeat(32) + '"}';
  assert.equal(eciesDecrypt(recipient, vaultEncrypt(publicFromSecret(recipient).toString("hex"), msg)), msg);
});

test("the secrets profile and the access rule follow section 6.2", () => {
  const escrow = "escrow.judgenear.testnet";
  assert.equal(secretsProfile(escrow, 42), `jn-${sha256hex(Buffer.from(escrow)).slice(0, 16)}-42`);
  const hash = "c".repeat(64);
  assert.deepEqual(accessRule(hash, escrow), {
    Logic: { operator: "And", conditions: [{ WasmHash: { hash } }, { Predecessor: { condition: { Whitelist: { accounts: [escrow] } } } }] },
  });
});

const hasWasmtime = spawnSync("wasmtime", ["--version"]).status === 0;
test("a deliverable sealed the agents' way passes the real judge, and the client opens k back to it", { skip: !hasWasmtime && "wasmtime not installed" }, () => {
  const K = crypto.randomBytes(32);
  const clientSecret = crypto.randomBytes(32);
  const criteria = fs.readFileSync(path.join(ROOT, "agents", "examples", "criteria.json"), "utf8");
  const plaintext = fs.readFileSync(path.join(ROOT, "agents", "examples", "deliverable.txt"));
  const C = encryptDeliverable(K, plaintext, crypto.randomBytes(12));
  const stdin = JSON.stringify({ criteria, deliverable_ct: C, dh: sha256hex(plaintext), client_pk: publicFromSecret(clientSecret).toString("hex") });
  const run = spawnSync("wasmtime", ["run", "--env", `JN_KEY=${K.toString("hex")}`, path.join(ROOT, "judge-wasm", "release", "judge.wasm")], { input: stdin });
  assert.equal(run.status, 0, String(run.stderr));
  const verdict = JSON.parse(run.stdout.toString());
  assert.equal(verdict.pass, true, run.stdout.toString());
  assert.equal(verdict.dh, sha256hex(plaintext));
  const recovered = openK(verdict.k, clientSecret.toString("hex"));
  assert.ok(recovered.equals(K), "k opens to K with the client secret");
  assert.deepEqual(decryptDeliverable(recovered, C), plaintext);
});
