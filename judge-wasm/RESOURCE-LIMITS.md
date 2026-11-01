# Resource limits for request_execution

Measured values for the contract's `resource_limits` when it calls OutLayer's
`request_execution` with this judge. Measured with `scripts/measure-limits.mjs`
on judge.wasm sha256 `da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1` (the path-safe build in BUILD.md),
under the same metering OutLayer uses (read from github.com/out-layer/outlayer at
aaf60a2, worker/src/executor/wasi_p1.rs and sandbox.rs):

- "instructions" = wasmtime 28 fuel (`config.consume_fuel(true)`, `store.set_fuel(max_instructions)`).
- memory cap = `StoreLimits::memory_size(max_memory_mb * 1 MiB)`.
- timeout = `max(max_execution_seconds, 5)` seconds, via a 1 Hz epoch counter.

## Method

For each input: binary-search the minimum fuel (`wasmtime -W fuel=N`) and the
minimum linear memory (`-W max-memory-size=N`) that let the run finish, and time a
normal run. Inputs are adversarial but valid: criteria up to 4096 bytes,
deliverable up to 16384 bytes, up to 16 checks, every input on the scoring path
(a verdict with no `err`). The families: whole-word `contains` packed with ~1,250
terms each found only at the end of the text (the costliest class), the same as
plain substrings, 16x length/checksum/schema/json, nested `anyOf`, and `uniqueBy`
over ~1,450 items.

## Worst case observed

| metric | worst input | value |
|---|---|---|
| instructions (fuel) | json x16, nested anyOf over nested arrays | 589,750,000 |
| linear memory | json x16, ~1,450 items, items + uniqueBy | 1,792 KiB (~1.75 MB) |
| execution time | same json anyOf case | ~21 ms (plus ~60-100 ms compile) |

Whole-word matching was the first bottleneck (17.4 billion instructions before it
was made linear); after the fix the whole-word families cost 10-14M for the
single-char/empty-term cases and up to 577M when ~780 distinct terms each defeat
memoization. json with nested `anyOf` is now the ceiling at ~0.59B.

## Recommended limits

| field | recommend | why |
|---|---|---|
| `max_instructions` | 3,000,000,000 (3B) | ~5x the 0.59B worst case; well under the 500B testnet cap. Instructions barely move the deposit (see below), so the headroom is cheap. |
| `max_memory_mb` | 16 | ~9x the 1.75 MB peak; memory is not in the deposit formula, so this is free headroom. |
| `max_execution_seconds` | 5 | Runs finish in tens of ms; the worker floors the timeout at 5 s anyway, and this is the one field that meaningfully scales the deposit. |
| `build_target` | `"wasm32-wasip1"` | Confirmed: a core module, runs on OutLayer's wasi_p1 path (not wasip2). |

## Deposit impact (why 3B instructions is safe)

The contract's `estimate_cost` (contract/src/lib.rs) is
`base_fee + (max_instructions / 1e6) * per_million_fee + (max_execution_seconds * 1000) * per_ms_fee`.
With the testnet defaults (base 0.001 NEAR, per_million 1e14 yocto, per_ms 1e17 yocto):

- base: 0.001 NEAR
- 3B instructions: (3000) * 1e14 = 3e17 yocto = 0.0000003 NEAR
- 5 s: 5000 * 1e17 = 5e20 yocto = 0.0005 NEAR

So ~0.0015 NEAR total, dominated by the base fee and the time term. Raising
`max_instructions` from the 1B default to 3B adds ~0.0000002 NEAR: negligible.
`max_execution_seconds` is the field to keep tight, not instructions.

## Why not just use the 1B default

The measured worst case (0.59B) is under the 1B default today, but the margin is
thin and input-dependent. If a future change pushed any valid input over the
limit, the run would exhaust fuel, OutLayer would return `null`, and that job
could never be ruled: it would fall through to the expiry refund, which is the
stall interface.md section 4 forbids. 3B gives real headroom at no meaningful
cost, so the limit covers the worst valid input, not a typical one.
