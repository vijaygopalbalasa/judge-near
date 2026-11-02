// The only place that touches the network or a NEAR account key. The key is read from
// ~/.near-credentials/testnet/<account>.json inside this process, handed straight to
// near-api-js, and never returned, printed or logged.

import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import { ACCOUNT_ID, NETWORK } from "./config.mjs";

/** The account's "ed25519:..." key string. Exported for tests only. */
export function loadAccountKey(home, accountId) {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not a NEAR account id: ${accountId}`);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(path.join(home, ".near-credentials", NETWORK, `${accountId}.json`), "utf8")).private_key;
  } catch {
    throw new Error(`no NEAR key for ${accountId} in ~/.near-credentials/${NETWORK}/`);
  }
  if (typeof key !== "string" || !key.startsWith("ed25519:")) {
    throw new Error(`the NEAR key file for ${accountId} has an unexpected shape`);
  }
  return key;
}

/** { view, call, txStatus } over a JSON-RPC endpoint. */
export function createNear({ rpcUrl, home }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    /** A view call; returns the parsed JSON result. */
    view: (contractId, method, args) => provider.callFunction({ contractId, method, args }),

    /** A signed function call. Returns the transaction hash and the RPC outcome. */
    async call(signerId, call, { waitUntil = "FINAL" } = {}) {
      const account = new Account(signerId, provider, loadAccountKey(home, signerId));
      const outcome = await account.callFunctionRaw({
        contractId: call.contractId,
        methodName: call.methodName,
        args: call.args,
        gas: teraToGas(call.gasTgas),
        deposit: BigInt(call.depositYocto),
        waitUntil,
      });
      return { txHash: outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id, outcome };
    },

    /** The transaction with all its receipts, once final (throws while still pending). */
    txStatus: (txHash, signerId) =>
      provider.viewTransactionStatusWithReceipts({ txHash, accountId: signerId, waitUntil: "FINAL" }),
  };
}
