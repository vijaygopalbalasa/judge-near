// Fixed settings for the Judge on NEAR agents (testnet only).

export const NETWORK = "testnet";
export const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";
export const OUTLAYER = "outlayer.testnet";
export const KEYSTORE_PUBKEY_URL = "https://testnet-api.outlayer.ai/secrets/pubkey";
export const USER_AGENT = "judge-near-agents/0.1";

// Interface limits (docs/interface.md sections 1 and 6.1).
export const MAX_CRITERIA_BYTES = 4096;
export const MAX_DELIVERABLE_BYTES = 16384;

// Gas per call, in Tgas.
export const GAS_TGAS = {
  create_job: "30",
  fund: "30",
  submit: "30",
  submit_sealed: "30",
  store_secrets: "50",
  request_ruling: "300",
};

// Deposits in NEAR. The escrow charges storage at actual cost and refunds the rest, so
// these only need to be at least enough: 4 KB of criteria, 16 KB of deliverable, or a
// 21,884-character sealed ciphertext. store_secrets takes OutLayer's 0.1 NEAR.
export const DEPOSIT_NEAR = {
  create_job: "0.1",
  submit: "0.2",
  submit_sealed: "0.25",
  store_secrets: "0.1",
};

// A ruling waits for OutLayer to run the judge and resume the call (about 200 blocks at
// most), so poll for up to five minutes.
export const RULING_POLL_MS = 5_000;
export const RULING_TIMEOUT_MS = 300_000;

// NEAR account id rules; also keeps account ids safe to use in file names.
export const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
