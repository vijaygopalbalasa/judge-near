// npm run demo: both agents, the real judge and real encryption on the in-memory escrow (lib/demo-chain.mjs),
// with no NEAR account, no network and no key file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { runDemo } from "../demo.mjs";

test("the demo runs a pass and a fail end to end, offline, and removes everything it wrote", async () => {
  const lines = [];
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("jn-demo-")).length;
  const before = leftovers();
  const result = await runDemo({ out: (s) => lines.push(s) });
  assert.deepEqual(
    { state: result.pass.state, keyReleased: result.pass.keyReleased, opened: result.pass.opened, vaultEmpty: result.pass.vaultEmpty },
    { state: "Completed", keyReleased: true, opened: true, vaultEmpty: true },
  );
  assert.deepEqual(
    { state: result.fail.state, keyReleased: result.fail.keyReleased, opened: result.fail.opened, vaultEmpty: result.fail.vaultEmpty },
    { state: "Refunded", keyReleased: false, opened: false, vaultEmpty: true },
  );
  const text = lines.join("\n");
  assert.match(text, /No NEAR account, no network/);
  assert.match(text, /^\[client\] /m);
  assert.match(text, /^\[worker\] /m);
  assert.match(text, /the worker was paid and the client opened the exact report/);
  assert.match(text, /the client was refunded and the key was never released/);
  assert.equal(leftovers(), before, "its temporary folders are gone");
});
