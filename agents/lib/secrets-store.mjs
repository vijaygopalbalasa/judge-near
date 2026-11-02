// Local secrets of the agents, kept only under ~/.judge-near/<account>/ (directory 0700,
// files 0600, never inside the repository). The client's X25519 secret is filed by its
// public key, because create_job returns the job id only after the transaction; the
// provider's K is filed by escrow and job. Loaders return Buffers that callers pass
// straight to the crypto functions; nothing here prints or returns a secret as text.

import fs from "node:fs";
import path from "node:path";
import { publicFromSecret } from "../../judge-wasm/scripts/sealed.mjs";
import { ACCOUNT_ID } from "./config.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

function accountDir(home, account) {
  if (!ACCOUNT_ID.test(account)) throw new Error(`not a NEAR account id: ${account}`);
  const root = path.join(home, ".judge-near");
  const dir = path.join(root, account);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The path as shown to the user: relative to the home directory, so no user name. */
const shown = (account, name) => `~/.judge-near/${account}/${name}`;

function writeSecret(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
}

/** Save a new client X25519 secret for `account`; returns where (for display). */
export function saveClientKey(home, account, clientPkHex, secret32) {
  if (!HEX64.test(clientPkHex) || publicFromSecret(secret32).toString("hex") !== clientPkHex) {
    throw new Error("client key pair does not match");
  }
  const name = `x25519-${clientPkHex}.json`;
  writeSecret(path.join(accountDir(home, account), name), { client_pk: clientPkHex, client_sk: secret32.toString("hex") });
  return shown(account, name);
}

/** The client X25519 secret behind `clientPkHex`, as a Buffer. */
export function loadClientKey(home, account, clientPkHex) {
  if (!HEX64.test(clientPkHex)) throw new Error("the job's client_pk is not 64 lowercase hex");
  const name = `x25519-${clientPkHex}.json`;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(accountDir(home, account), name), "utf8"));
  } catch {
    throw new Error(`no client key for this job under ${shown(account, name)} (was the job created as ${account}?)`);
  }
  const secret = Buffer.from(String(saved.client_sk), "hex");
  if (secret.length !== 32 || publicFromSecret(secret).toString("hex") !== clientPkHex) {
    throw new Error(`the client key file ${shown(account, name)} does not match the job's client_pk`);
  }
  return secret;
}

/** The provider's K for this job: reused if already saved (so a retry keeps the same key),
 *  otherwise 32 bytes from `rng`, saved before any transaction uses it. */
export function loadOrCreateK(home, account, escrow, jobId, rng) {
  if (!ACCOUNT_ID.test(escrow)) throw new Error(`not a NEAR account id: ${escrow}`);
  const name = `K-${escrow}-${jobId}.json`;
  const file = path.join(accountDir(home, account), name);
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const K = Buffer.from(String(saved.jn_key), "hex");
    if (K.length !== 32 || saved.escrow !== escrow || saved.job_id !== jobId) throw new Error(`${shown(account, name)} is not a K for this job`);
    return { K, created: false, where: shown(account, name) };
  }
  const K = rng(32);
  writeSecret(file, { escrow, job_id: jobId, jn_key: K.toString("hex") });
  return { K, created: true, where: shown(account, name) };
}
