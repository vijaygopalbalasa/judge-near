# Resource limits for request_execution

Measured values for the contract's `resource_limits` when it calls OutLayer's
`request_execution` with this judge. Measured with `scripts/measure-limits.mjs`
on judge.wasm sha256 `911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958`
(the path-safe build in BUILD.md, with sealed jobs), under the same metering OutLayer
uses (read from github.com/out-layer/outlayer at aaf60a2, worker/src/executor/wasi_p1.rs
and sandbox.rs):

- "instructions" = wasmtime 28 fuel (`config.consume_fuel(true)`, `store.set_fuel(max_instructions)`).
- memory cap = `StoreLimits::memory_size(max_memory_mb * 1 MiB)`.
- timeout = `max(max_execution_seconds, 5)` seconds, via a 1 Hz epoch counter.

## Method

For each input: binary-search the minimum fuel (`wasmtime -W fuel=N`) and the
minimum linear memory (`-W max-memory-size=N`) that let the run finish, and time a
normal run. Inputs are adversarial but valid: criteria up to 4096 bytes,
deliverable up to 16384 bytes, up to 16 checks. Public families: whole-word
`contains` packed with ~1,250 terms each found only at the end of the text, the same
as plain substrings, 16x length/checksum/schema/json, nested `anyOf`, and `uniqueBy`
over ~1,450 items. Sealed families (docs/interface.md section 6.3, from
`vectors/fuel/*sealed*`): the heaviest public inputs encrypted at full size, so the
judge decrypts up to 16 KB, runs the checks, and on a pass derives `k` (HKDF and two
X25519 operations); plus a full-size `bad_delivery` (wrong key) and `key_missing`.

## Worst case observed

| metric | worst input | value |
|---|---|---|
| instructions (fuel) | sealed pass: 16 json checks, nested anyOf over nested arrays, with `k` | 602,500,000 |
| linear memory | public: 16 json checks over ~1,450 items with `uniqueBy` | 1,792 KiB (~1.75 MB) |
| execution time | the sealed nested-anyOf pass | ~22 ms (plus tens of ms for start and compile) |

Sealed jobs add about 13 million instructions to the same checks (602.5M for the
sealed nested-anyOf pass against 589.75M for the public one): decrypting 16 KB,
hashing it, HKDF and two X25519 operations. A sealed pass of a 16 KB plaintext with a
cheap check costs 14.9M; a full-size `bad_delivery` stops at the tag check (2.6M); a
`key_missing` costs 0.34M. The checks still dominate: json with nested `anyOf` is the
ceiling, and the whole-word families top out near 590M (17.4 billion before matching
was made linear).

## Limits

The escrow requests **50,000,000,000 instructions, 64 MB and 30 seconds**
(docs/interface.md section 4). Against the measured worst case:

| field | escrow requests | worst valid input | margin |
|---|---|---|---|
| `max_instructions` | 50,000,000,000 | 602,500,000 | ~83x |
| `max_memory_mb` | 64 | ~1.75 MB | ~36x |
| `max_execution_seconds` | 30 | ~22 ms | ~1,300x |
| `build_target` | `"wasm32-wasip1"` | | a core module, OutLayer's wasi_p1 path |

`scripts/fuel-check.sh` guards the instruction bound much more tightly: by default
it runs every corpus case (21, sealed included) under 3,000,000,000, so a regression
is caught long before it could approach the 50 billion the escrow asks for.

## Deposit impact

The OutLayer contract's `estimate_cost` (contract/src/lib.rs at aaf60a2) is
`base_fee + (max_instructions / 1e6) * per_million_fee + (max_execution_seconds * 1000) * per_ms_fee`.
With the testnet values (base 0.001 NEAR, per_million 1e14 yocto, per_ms 1e17 yocto):

- base: 0.001 NEAR
- 50B instructions: 50,000 * 1e14 = 5e18 yocto = 0.000005 NEAR
- 30 s: 30,000 * 1e17 = 3e21 yocto = 0.003 NEAR

So about 0.004 NEAR, dominated by the base fee and the time term. Instructions are
nearly free at this price, which is why a generous instruction cap costs nothing;
`max_execution_seconds` is the field that moves the deposit.

## Why the limit must cover the worst valid input

If any valid input exhausted the run, OutLayer would return `null` and that job could
never be ruled: it would fall through to the expiry refund, the stall interface.md
section 4 forbids. So the limit is set from the worst valid input, not a typical one,
and the fuel guard fails the build if that worst case grows.
