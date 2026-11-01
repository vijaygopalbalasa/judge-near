//! Judge on NEAR, escrow contract.
//!
//! A neutral escrow for agent jobs. The payout follows a deterministic verdict produced by a WASM
//! judge run inside OutLayer (TEE-attested WASI execution). This contract never scores anything
//! itself: it holds the job, forwards the criteria and the deliverable to OutLayer, and acts on the
//! verdict in a callback. The judge source (url, hash, build target) is fixed at init and cannot be
//! changed by anyone, and there is no owner or admin.
//!
//! See ../docs/interface.md sections 4 and 5 for the binding contract with OutLayer. The OutLayer
//! types below (ExecutionSource, ResourceLimits, ResponseFormat) and the request_execution argument
//! order are matched to github.com/out-layer/outlayer (contract/src/lib.rs, execution.rs).

use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Deserialize;
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env,
    ext_contract, near, require,
};

// ---------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------

/// Max UTF-8 bytes for criteria (interface.md section 1).
const MAX_CRITERIA_BYTES: usize = 4_096;
/// Max UTF-8 bytes for deliverable (interface.md section 1).
const MAX_DELIVERABLE_BYTES: usize = 16_384;

/// One hour in nanoseconds. A job stuck in Ruling can be refunded only after expiry plus this
/// grace, so a lost OutLayer callback can never lock the escrow forever.
const GRACE_NS: u64 = 3_600_000_000_000;

/// Static gas floor for the OutLayer request_execution call. OutLayer reserves MIN_RESPONSE_GAS
/// (50 TGas) for its own settlement callback and needs a little more for its body; 100 TGas covers
/// that. with_unused_gas_weight(1) hands OutLayer all the gas the caller left unused on top, which is
/// what OutLayer's own proxy guidance recommends.
const GAS_OUTLAYER_REQUEST: Gas = Gas::from_tgas(100);
/// Gas reserved for our on_ruling callback: parse at most ~1 KiB, reload and rewrite the job (up to
/// ~20 KiB), one event, one transfer.
const GAS_ON_RULING: Gas = Gas::from_tgas(40);
/// Minimum prepaid gas required to call request_ruling. Covers the two static reserves (100 + 40)
/// plus the request_ruling body, and still leaves unused gas for OutLayer via the weight above.
const MIN_PREPAID_GAS: Gas = Gas::from_tgas(170);

/// Resource limits sent to OutLayer: 50 billion instructions, 64 MB, 30 seconds (the team lead's
/// decision, also bound by docs/interface.md section 4).
///
/// The judge's measured worst valid input (criteria 4096 B, deliverable 16384 B, 16 checks, under
/// OutLayer's own metering) is about 0.59B instructions, 1.75 MB and 21 ms. But a measured corpus is
/// not a proof that no valid criteria cost more, and a ruling that runs out of fuel stalls the job
/// (OutLayer returns null on every attempt). Generous limits are nearly free: on testnet pricing the
/// deposit estimate for 50B / 30 s is about 0.004 NEAR (base 0.001 + 0.000005 for instructions +
/// 0.003 for time), under the 0.01 NEAR min_ruling_deposit used in docs, and OutLayer charges actual
/// usage and refunds the rest to the payer. All three stay far below the testnet maximums (500B
/// instructions, 180 s).
const JUDGE_MAX_INSTRUCTIONS: u64 = 50_000_000_000;
const JUDGE_MAX_MEMORY_MB: u32 = 64;
const JUDGE_MAX_EXECUTION_SECONDS: u64 = 30;

/// Verdict envelope (interface.md section 3).
const VERDICT_VERSION: u8 = 1;
/// Max bytes we read from the OutLayer result. The verdict is at most 900 bytes (interface.md
/// section 3); a longer result is rejected as oversized rather than costing gas to read in full.
const MAX_VERDICT_BYTES: usize = 1_024;

const EVENT_STANDARD: &str = "judge_near";
const EVENT_VERSION: &str = "1.0.0";

// ---------------------------------------------------------------------------
// OutLayer interface, matched to the deployed contract
// ---------------------------------------------------------------------------

/// Execution source. Only the WasmUrl variant is used; a single-variant enum serializes to the same
/// externally tagged JSON `{"WasmUrl":{...}}` the full OutLayer enum produces.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum ExecutionSource {
    WasmUrl {
        url: String,
        hash: String,
        build_target: Option<String>,
    },
}

/// Resource limits, field names and types matched to OutLayer's ResourceLimits.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ResourceLimits {
    pub max_instructions: Option<u64>,
    pub max_memory_mb: Option<u32>,
    pub max_execution_seconds: Option<u64>,
}

/// Response format. Only Json is used; it serializes to the string `"Json"`, matching OutLayer.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum ResponseFormat {
    Json,
}

/// The OutLayer method we call. The argument order and names match OutLayer exactly so NEAR's
/// cross-contract JSON object (keys = parameter names) deserializes there. secrets_ref and params
/// are always None (null); their inner type is irrelevant to a null value, so Value keeps this
/// contract free of OutLayer's internal shapes.
#[ext_contract(ext_outlayer)]
pub trait OutLayer {
    fn request_execution(
        &mut self,
        source: ExecutionSource,
        resource_limits: Option<ResourceLimits>,
        input_data: Option<String>,
        secrets_ref: Option<near_sdk::serde_json::Value>,
        response_format: Option<ResponseFormat>,
        payer_account_id: Option<AccountId>,
        params: Option<near_sdk::serde_json::Value>,
    );
}

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobState {
    Open,
    Funded,
    Submitted,
    Ruling,
    Completed,
    Refunded,
}

/// Stored job. borsh only: it is never returned directly, get_job maps it to JobView.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Job {
    pub client: AccountId,
    pub provider: AccountId,
    pub criteria: String,
    /// sha256 hex of the criteria bytes.
    pub ch: String,
    pub deliverable: String,
    /// sha256 hex of the deliverable bytes (empty until submit).
    pub dh: String,
    /// Escrow amount, set on fund. Only ever paid to provider or refunded to client.
    pub amount: NearToken,
    pub state: JobState,
    pub expires_at_ns: u64,
    /// Ruling attempt counter. Guards stale or replayed callbacks.
    pub attempt: u64,
    pub created_at_ns: u64,
}

/// JSON view of a job. u64 timestamps and counters are U64 so JS clients do not lose precision.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JobView {
    pub client: AccountId,
    pub provider: AccountId,
    pub criteria: String,
    pub ch: String,
    pub deliverable: String,
    pub dh: String,
    pub amount: NearToken,
    pub state: JobState,
    pub expires_at_ns: U64,
    pub attempt: U64,
    pub created_at_ns: U64,
}

impl JobView {
    fn of(id: u64, j: &Job) -> Self {
        let _ = id;
        Self {
            client: j.client.clone(),
            provider: j.provider.clone(),
            criteria: j.criteria.clone(),
            ch: j.ch.clone(),
            deliverable: j.deliverable.clone(),
            dh: j.dh.clone(),
            amount: j.amount,
            state: j.state.clone(),
            expires_at_ns: U64(j.expires_at_ns),
            attempt: U64(j.attempt),
            created_at_ns: U64(j.created_at_ns),
        }
    }
}

/// JSON view of the fixed judge configuration.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JudgeView {
    pub outlayer: AccountId,
    pub url: String,
    pub hash: String,
    pub build_target: String,
    /// Minimum deposit request_ruling accepts, in yoctoNEAR. Fixed at init.
    pub min_ruling_deposit: U128,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jobs,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// OutLayer account (outlayer.testnet / outlayer.near). Fixed at init.
    outlayer: AccountId,
    /// Judge WASM https URL. Fixed at init.
    judge_url: String,
    /// Judge WASM sha256, 64 lowercase hex. Fixed at init.
    judge_hash: String,
    /// Judge build target (for example wasm32-wasip1). Fixed at init.
    build_target: String,
    /// Minimum OutLayer payment request_ruling accepts. Fixed at init.
    min_ruling_deposit: NearToken,
    jobs: IterableMap<u64, Job>,
    next_id: u64,
}

#[near]
impl Contract {
    /// Store the judge source and the minimum ruling deposit permanently. No method can change them
    /// later; there is no owner.
    #[init]
    pub fn new(
        outlayer: AccountId,
        judge_url: String,
        judge_hash: String,
        build_target: String,
        min_ruling_deposit: U128,
    ) -> Self {
        require!(
            judge_url.starts_with("https://"),
            "judge_url must start with https://"
        );
        require!(
            is_64_lower_hex(&judge_hash),
            "judge_hash must be 64 lowercase hex characters"
        );
        require!(!build_target.is_empty(), "build_target must not be empty");
        require!(
            min_ruling_deposit.0 > 0,
            "min_ruling_deposit must be greater than zero"
        );
        Self {
            outlayer,
            judge_url,
            judge_hash,
            build_target,
            min_ruling_deposit: NearToken::from_yoctonear(min_ruling_deposit.0),
            jobs: IterableMap::new(StorageKey::Jobs),
            next_id: 0,
        }
    }

    /// Create a job. client = predecessor. Attach a deposit to cover storage; the excess is
    /// refunded. The deposit here is storage only, never escrow.
    #[payable]
    pub fn create_job(&mut self, provider: AccountId, criteria: String, expires_at_ns: U64) -> u64 {
        let client = env::predecessor_account_id();
        require!(provider != client, "provider must differ from client");
        require!(
            criteria.len() <= MAX_CRITERIA_BYTES,
            "criteria exceeds 4096 bytes"
        );
        let now = env::block_timestamp();
        let expires = expires_at_ns.0;
        require!(expires > now, "expires_at_ns must be in the future");

        let ch = sha256_hex(criteria.as_bytes());
        let id = self.next_id;
        let before = env::storage_usage();
        let job = Job {
            client: client.clone(),
            provider: provider.clone(),
            criteria,
            ch: ch.clone(),
            deliverable: String::new(),
            dh: String::new(),
            amount: NearToken::from_yoctonear(0),
            state: JobState::Open,
            expires_at_ns: expires,
            attempt: 0,
            created_at_ns: now,
        };
        self.jobs.insert(id, job);
        self.next_id += 1;
        self.jobs.flush();
        charge_storage(before, &client);
        event_job_created(id, &client, &provider, &ch, expires);
        id
    }

    /// Fund the escrow. Only the client, only when Open. The attached deposit is the escrow amount.
    #[payable]
    pub fn fund(&mut self, job_id: u64) {
        let amount = env::attached_deposit();
        require!(amount.as_yoctonear() > 0, "attach the escrow amount");
        {
            let job = self.jobs.get_mut(&job_id).expect("no such job");
            require!(
                env::predecessor_account_id() == job.client,
                "only the client can fund"
            );
            require!(job.state == JobState::Open, "job is not Open");
            job.amount = amount;
            job.state = JobState::Funded;
        }
        event_job_funded(job_id, amount);
    }

    /// Submit the deliverable. Only the provider, only when Funded, only before expiry. Attach a
    /// deposit to cover deliverable storage; the excess is refunded. Storage only, never escrow.
    #[payable]
    pub fn submit(&mut self, job_id: u64, deliverable: String) {
        require!(
            deliverable.len() <= MAX_DELIVERABLE_BYTES,
            "deliverable exceeds 16384 bytes"
        );
        let dh = sha256_hex(deliverable.as_bytes());
        let before = env::storage_usage();
        let provider;
        {
            let job = self.jobs.get_mut(&job_id).expect("no such job");
            require!(
                env::predecessor_account_id() == job.provider,
                "only the provider can submit"
            );
            require!(job.state == JobState::Funded, "job is not Funded");
            require!(
                env::block_timestamp() < job.expires_at_ns,
                "job has expired"
            );
            provider = job.provider.clone();
            job.deliverable = deliverable;
            job.dh = dh.clone();
            job.state = JobState::Submitted;
        }
        self.jobs.flush();
        charge_storage(before, &provider);
        event_deliverable_submitted(job_id, &dh);
    }

    /// Ask OutLayer for a ruling. Only the job's client or provider may call. The attached deposit is
    /// the OutLayer payment and is forwarded; OutLayer refunds the unused part to the caller
    /// (payer_account_id). Moves the job to Ruling and bumps the attempt counter.
    ///
    /// Why only the parties: each has a reason to ask (the provider to get paid, the client to get a
    /// refund on a failing delivery), so restricting the caller loses nothing, while it stops a third
    /// party from spamming failing requests to stall a job. If neither party ever asks, money still
    /// cannot lock: claim_refund opens at expires_at + GRACE_NS for a Submitted job.
    #[payable]
    pub fn request_ruling(&mut self, job_id: u64) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS,
            "attach at least 170 TGas"
        );
        let deposit = env::attached_deposit();
        // A deposit below what OutLayer needs makes the call fail and only flips the job back to
        // Submitted. The floor (fixed at init) makes every accepted request a real ruling attempt,
        // so spamming cheap failing requests stops being a way to stall a job.
        require!(
            deposit >= self.min_ruling_deposit,
            "attach at least min_ruling_deposit for the OutLayer payment"
        );
        let payer = env::predecessor_account_id();

        let criteria;
        let deliverable;
        let attempt;
        {
            let job = self.jobs.get_mut(&job_id).expect("no such job");
            require!(
                payer == job.client || payer == job.provider,
                "only the job's client or provider can request a ruling"
            );
            require!(job.state == JobState::Submitted, "job is not Submitted");
            job.attempt += 1;
            job.state = JobState::Ruling;
            attempt = job.attempt;
            criteria = job.criteria.clone();
            deliverable = job.deliverable.clone();
        }

        // input_data is the stdin of the judge WASM (interface.md section 1): a JSON object whose
        // two values are the exact stored strings. Serialized to a String because OutLayer's
        // input_data is Option<String>.
        let input_data = near_sdk::serde_json::json!({
            "criteria": criteria,
            "deliverable": deliverable,
        })
        .to_string();

        let source = ExecutionSource::WasmUrl {
            url: self.judge_url.clone(),
            hash: self.judge_hash.clone(),
            build_target: Some(self.build_target.clone()),
        };
        let limits = ResourceLimits {
            max_instructions: Some(JUDGE_MAX_INSTRUCTIONS),
            max_memory_mb: Some(JUDGE_MAX_MEMORY_MB),
            max_execution_seconds: Some(JUDGE_MAX_EXECUTION_SECONDS),
        };

        event_ruling_requested(job_id, attempt, &payer);

        ext_outlayer::ext(self.outlayer.clone())
            .with_attached_deposit(deposit)
            .with_static_gas(GAS_OUTLAYER_REQUEST)
            .with_unused_gas_weight(1)
            .request_execution(
                source,
                Some(limits),
                Some(input_data),
                None,
                Some(ResponseFormat::Json),
                Some(payer),
                None,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RULING)
                    .with_unused_gas_weight(0)
                    .on_ruling(job_id, attempt),
            )
    }

    /// Settlement callback. Reads the RAW promise result (never a typed callback that could panic on
    /// a surprise shape). Moves money only on a valid verdict for the live ruling; otherwise moves
    /// nothing. Never panics.
    #[private]
    pub fn on_ruling(&mut self, job_id: u64, attempt: u64) {
        // Read the RAW result, bounded so a huge output cannot drain the callback's gas. Never a
        // typed callback that could panic on a surprise shape.
        let outcome = env::promise_result_checked(0, MAX_VERDICT_BYTES);

        let job = match self.jobs.get(&job_id) {
            Some(j) => j.clone(),
            None => return,
        };

        // Act only on the live ruling. A late callback on a job that moved on (for example refunded
        // after the grace period) must leave it exactly as it is.
        if job.state != JobState::Ruling || job.attempt != attempt {
            event_ruling_rejected(job_id, "stale_or_not_ruling");
            return;
        }

        match outcome {
            // The request_execution promise failed. Two causes are indistinguishable here: the call
            // never ran (refund already returned to this contract) or OutLayer's own settlement
            // failed (deposit not returned). Since we cannot tell, we move NO money and return the
            // job to Submitted so a ruling can be retried. A deposit from a failed call stays in the
            // contract (documented in NOTES.md).
            Err(PromiseError::Failed) => {
                self.set_state(job_id, JobState::Submitted);
                event_ruling_rejected(job_id, "outlayer_call_failed");
            }
            // Output longer than a valid verdict can be. Treat as invalid: no money, back to
            // Submitted.
            Err(PromiseError::TooLong(_)) => {
                self.set_state(job_id, JobState::Submitted);
                event_ruling_rejected(job_id, "verdict_too_large");
            }
            // PromiseError is non_exhaustive. Any future error is handled the same safe way: no
            // money moves, the job returns to Submitted.
            Err(_) => {
                self.set_state(job_id, JobState::Submitted);
                event_ruling_rejected(job_id, "outlayer_call_failed");
            }
            Ok(bytes) => match parse_verdict(&bytes, &job.ch, &job.dh) {
                Some(v) if v.pass => {
                    // State before transfer. Completed closes the job to any further payout.
                    self.set_state(job_id, JobState::Completed);
                    event_ruling_applied(job_id, true, v.score, &v.eh);
                    event_completed(job_id, &job.provider, job.amount);
                    Promise::new(job.provider.clone())
                        .transfer(job.amount)
                        .detach();
                }
                Some(v) => {
                    self.set_state(job_id, JobState::Refunded);
                    event_ruling_applied(job_id, false, v.score, &v.eh);
                    event_refunded(job_id, &job.client, job.amount);
                    Promise::new(job.client.clone())
                        .transfer(job.amount)
                        .detach();
                }
                None => {
                    // null, garbage, wrong version, or ch/dh mismatch. In these cases OutLayer's
                    // call succeeded, so it already refunded the OutLayer deposit to the caller; we
                    // only return the job to Submitted and move no escrow money.
                    self.set_state(job_id, JobState::Submitted);
                    event_ruling_rejected(job_id, "invalid_verdict");
                }
            },
        }
    }

    /// Refund the client. Anyone may call; the money always goes to the client.
    ///
    /// - Funded (nothing delivered): refundable at expires_at.
    /// - Submitted or Ruling (work delivered on time): refundable only at expires_at + GRACE_NS. The
    ///   grace window guarantees delivered work a chance at a real ruling after expiry, so a party
    ///   cannot stall rulings (for example with failing requests) and then refund at expires_at. It
    ///   also covers a lost OutLayer callback, so money can never lock.
    pub fn claim_refund(&mut self, job_id: u64) {
        let job = self.jobs.get(&job_id).expect("no such job").clone();
        let now = env::block_timestamp();
        let refundable = match job.state {
            JobState::Funded => now >= job.expires_at_ns,
            JobState::Submitted | JobState::Ruling => now >= job.expires_at_ns.saturating_add(GRACE_NS),
            _ => false,
        };
        require!(refundable, "job is not refundable yet");
        self.set_state(job_id, JobState::Refunded);
        event_refunded(job_id, &job.client, job.amount);
        Promise::new(job.client.clone())
            .transfer(job.amount)
            .detach();
    }

    // ---- views ----

    pub fn get_job(&self, job_id: u64) -> Option<JobView> {
        self.jobs.get(&job_id).map(|j| JobView::of(job_id, j))
    }

    pub fn get_judge(&self) -> JudgeView {
        JudgeView {
            outlayer: self.outlayer.clone(),
            url: self.judge_url.clone(),
            hash: self.judge_hash.clone(),
            build_target: self.build_target.clone(),
            min_ruling_deposit: U128(self.min_ruling_deposit.as_yoctonear()),
        }
    }

    pub fn list_jobs(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<JobView> {
        let from = from_index.unwrap_or(0) as u64;
        // Jobs can hold up to ~20 KiB each, so the default page is small to keep a view response
        // well bounded. Callers can page with from_index and limit.
        let lim = limit.unwrap_or(10) as u64;
        let end = from.saturating_add(lim).min(self.next_id);
        let mut out = Vec::new();
        let mut id = from;
        while id < end {
            if let Some(j) = self.jobs.get(&id) {
                out.push(JobView::of(id, j));
            }
            id += 1;
        }
        out
    }

    // ---- internal ----

    fn set_state(&mut self, job_id: u64, state: JobState) {
        if let Some(job) = self.jobs.get_mut(&job_id) {
            job.state = state;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_64_lower_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(env::sha256(bytes))
}

/// Charge the deposit for the storage used since `before` (the collection must be flushed first),
/// and refund any excess to `payer`. Panics (reverting all state) if the deposit is short.
fn charge_storage(before: u64, payer: &AccountId) {
    let used = env::storage_usage().saturating_sub(before);
    let cost = NearToken::from_yoctonear(
        env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(used as u128),
    );
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        "attached deposit does not cover storage"
    );
    let refund = attached.saturating_sub(cost);
    if refund.as_yoctonear() > 0 {
        Promise::new(payer.clone()).transfer(refund).detach();
    }
}

struct ParsedVerdict {
    pass: bool,
    score: u8,
    eh: String,
}

/// Parse raw OutLayer result bytes into a verdict, returning None for anything we must not act on:
/// bytes that do not parse (including the literal `null`), a wrong version, or a criteria/deliverable
/// hash that does not match what we stored for the job.
fn parse_verdict(bytes: &[u8], want_ch: &str, want_dh: &str) -> Option<ParsedVerdict> {
    let v: VerdictJson = near_sdk::serde_json::from_slice(bytes).ok()?;
    if v.v != VERDICT_VERSION {
        return None;
    }
    if v.ch != want_ch || v.dh != want_dh {
        return None;
    }
    Some(ParsedVerdict {
        pass: v.pass,
        score: v.score,
        eh: v.eh,
    })
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VerdictJson {
    v: u8,
    pass: bool,
    #[serde(default)]
    score: u8,
    ch: String,
    dh: String,
    #[serde(default)]
    eh: String,
}

// ---------------------------------------------------------------------------
// Events (NEP-297)
// ---------------------------------------------------------------------------

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = near_sdk::serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

fn event_job_created(id: u64, client: &AccountId, provider: &AccountId, ch: &str, expires: u64) {
    emit(
        "job_created",
        near_sdk::serde_json::json!({
            "job_id": id,
            "client": client.as_str(),
            "provider": provider.as_str(),
            "ch": ch,
            "expires_at_ns": expires.to_string(),
        }),
    );
}

fn event_job_funded(id: u64, amount: NearToken) {
    emit(
        "job_funded",
        near_sdk::serde_json::json!({
            "job_id": id,
            "amount": amount.as_yoctonear().to_string(),
        }),
    );
}

fn event_deliverable_submitted(id: u64, dh: &str) {
    emit(
        "deliverable_submitted",
        near_sdk::serde_json::json!({ "job_id": id, "dh": dh }),
    );
}

fn event_ruling_requested(id: u64, attempt: u64, payer: &AccountId) {
    emit(
        "ruling_requested",
        near_sdk::serde_json::json!({
            "job_id": id,
            "attempt": attempt,
            "payer": payer.as_str(),
        }),
    );
}

fn event_ruling_applied(id: u64, pass: bool, score: u8, eh: &str) {
    emit(
        "ruling_applied",
        near_sdk::serde_json::json!({
            "job_id": id,
            "pass": pass,
            "score": score,
            "eh": eh,
        }),
    );
}

fn event_ruling_rejected(id: u64, reason: &str) {
    emit(
        "ruling_rejected",
        near_sdk::serde_json::json!({ "job_id": id, "reason": reason }),
    );
}

fn event_refunded(id: u64, to: &AccountId, amount: NearToken) {
    emit(
        "refunded",
        near_sdk::serde_json::json!({
            "job_id": id,
            "to": to.as_str(),
            "amount": amount.as_yoctonear().to_string(),
        }),
    );
}

fn event_completed(id: u64, to: &AccountId, amount: NearToken) {
    emit(
        "completed",
        near_sdk::serde_json::json!({
            "job_id": id,
            "to": to.as_str(),
            "amount": amount.as_yoctonear().to_string(),
        }),
    );
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
    use near_sdk::{Gas, NearToken, PromiseResult, testing_env};

    const ESCROW: &str = "escrow.near";
    const OUTLAYER: &str = "outlayer.testnet";
    const CLIENT: &str = "client.near";
    const PROVIDER: &str = "provider.near";
    const RANGER: &str = "ranger.near";
    const JUDGE_URL: &str = "https://example.com/judge.wasm";
    const BUILD_TARGET: &str = "wasm32-wasip1";
    /// 0.01 NEAR, the minimum ruling deposit used in tests and docs (OutLayer estimate for our
    /// limits is well below it; unused deposit is refunded by OutLayer to the payer).
    const MIN_RULING: u128 = 10_000_000_000_000_000_000_000;

    const NOW: u64 = 1_000;
    const EXPIRES: u64 = 10_000_000_000; // 10 s in ns, well after NOW
    const CRITERIA: &str = "{\"checks\":[{\"kind\":\"length\"}],\"passThreshold\":100}";
    const DELIVERABLE: &str = "the quick brown fox";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn jhash() -> String {
        "a".repeat(64)
    }

    fn set_ctx(pred: &str, deposit: NearToken, ts: u64, gas: Gas) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(ESCROW))
            .predecessor_account_id(acc(pred))
            .signer_account_id(acc(pred))
            .block_timestamp(ts)
            .attached_deposit(deposit)
            .prepaid_gas(gas);
        testing_env!(b.build());
    }

    fn callback_ctx(results: Vec<PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(ESCROW))
            .predecessor_account_id(acc(ESCROW))
            .signer_account_id(acc(ESCROW))
            .block_timestamp(NOW)
            .prepaid_gas(Gas::from_tgas(50));
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results,
        );
    }

    fn new_contract() -> Contract {
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        Contract::new(
            acc(OUTLAYER),
            JUDGE_URL.to_string(),
            jhash(),
            BUILD_TARGET.to_string(),
            U128(MIN_RULING),
        )
    }

    /// Create + fund + submit, returning the contract with one job at index 0 in state Submitted.
    fn submitted_job() -> Contract {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let id = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        assert_eq!(id, 0);
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
        c
    }

    /// Drive a job to Ruling (attempt 1) by requesting a ruling as RANGER.
    fn ruling_job() -> Contract {
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        c
    }

    fn valid_verdict(pass: bool, ch: &str, dh: &str) -> String {
        format!(
            "{{\"v\":1,\"pass\":{pass},\"score\":{},\"th\":100,\"ch\":\"{ch}\",\"dh\":\"{dh}\",\"checks\":[],\"eh\":\"{}\"}}",
            if pass { 100 } else { 40 },
            "f".repeat(64)
        )
    }

    fn fn_call_to(receiver: &str) -> Option<(String, Vec<u8>, NearToken, Gas)> {
        for r in get_created_receipts() {
            if r.receiver_id == acc(receiver) {
                for a in r.actions {
                    if let MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        ..
                    } = a
                    {
                        return Some((
                            String::from_utf8(method_name).unwrap(),
                            args,
                            attached_deposit,
                            prepaid_gas,
                        ));
                    }
                }
            }
        }
        None
    }

    fn transfer_to(receiver: &str) -> Option<NearToken> {
        for r in get_created_receipts() {
            if r.receiver_id == acc(receiver) {
                for a in r.actions {
                    if let MockAction::Transfer { deposit, .. } = a {
                        return Some(deposit);
                    }
                }
            }
        }
        None
    }

    fn any_transfer() -> bool {
        get_created_receipts()
            .into_iter()
            .any(|r| r.actions.iter().any(|a| matches!(a, MockAction::Transfer { .. })))
    }

    // ---- new / init ----

    #[test]
    fn new_stores_judge_config() {
        let c = new_contract();
        let j = c.get_judge();
        assert_eq!(j.outlayer, acc(OUTLAYER));
        assert_eq!(j.url, JUDGE_URL);
        assert_eq!(j.hash, jhash());
        assert_eq!(j.build_target, BUILD_TARGET);
    }

    #[test]
    #[should_panic(expected = "https://")]
    fn new_rejects_non_https() {
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        Contract::new(
            acc(OUTLAYER),
            "http://example.com/j.wasm".to_string(),
            jhash(),
            BUILD_TARGET.to_string(),
            U128(MIN_RULING),
        );
    }

    #[test]
    #[should_panic(expected = "64 lowercase hex")]
    fn new_rejects_short_hash() {
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        Contract::new(
            acc(OUTLAYER),
            JUDGE_URL.to_string(),
            "abc".to_string(),
            BUILD_TARGET.to_string(),
            U128(MIN_RULING),
        );
    }

    #[test]
    #[should_panic(expected = "64 lowercase hex")]
    fn new_rejects_uppercase_hash() {
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        Contract::new(
            acc(OUTLAYER),
            JUDGE_URL.to_string(),
            "A".repeat(64),
            BUILD_TARGET.to_string(),
            U128(MIN_RULING),
        );
    }

    #[test]
    #[should_panic(expected = "build_target")]
    fn new_rejects_empty_build_target() {
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        Contract::new(
            acc(OUTLAYER),
            JUDGE_URL.to_string(),
            jhash(),
            String::new(),
            U128(MIN_RULING),
        );
    }

    #[test]
    fn get_judge_returns_min_ruling_deposit() {
        let c = new_contract();
        assert_eq!(c.get_judge().min_ruling_deposit, U128(MIN_RULING));
    }

    #[test]
    #[should_panic(expected = "min_ruling_deposit")]
    fn new_rejects_zero_min_ruling_deposit() {
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        Contract::new(
            acc(OUTLAYER),
            JUDGE_URL.to_string(),
            jhash(),
            BUILD_TARGET.to_string(),
            U128(0),
        );
    }

    #[test]
    #[should_panic(expected = "min_ruling_deposit")]
    fn request_ruling_rejects_deposit_below_min() {
        // A deposit too small for OutLayer to run the judge would make the call fail and flip the
        // job back to Submitted; the floor makes every accepted request a real ruling attempt.
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_yoctonear(MIN_RULING - 1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
    }

    #[test]
    fn request_ruling_accepts_deposit_at_min() {
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_yoctonear(MIN_RULING), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Ruling);
    }

    // ---- create_job ----

    #[test]
    fn create_job_happy() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let id = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        assert_eq!(id, 0);
        let job = c.get_job(0).unwrap();
        assert_eq!(job.client, acc(CLIENT));
        assert_eq!(job.provider, acc(PROVIDER));
        assert_eq!(job.state, JobState::Open);
        assert_eq!(job.ch, sha256_hex(CRITERIA.as_bytes()));
        assert_eq!(job.amount, NearToken::from_near(0));
        assert_eq!(job.expires_at_ns, U64(EXPIRES));
        assert!(get_logs().iter().any(|l| l.contains("job_created")));
    }

    #[test]
    fn create_job_increments_ids() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let a = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let b = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        assert_eq!((a, b), (0, 1));
    }

    #[test]
    #[should_panic(expected = "provider must differ")]
    fn create_job_rejects_self_dealing() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(CLIENT), CRITERIA.to_string(), U64(EXPIRES));
    }

    #[test]
    #[should_panic(expected = "criteria exceeds")]
    fn create_job_rejects_oversized_criteria() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), "x".repeat(4097), U64(EXPIRES));
    }

    #[test]
    fn create_job_allows_max_criteria() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let id = c.create_job(acc(PROVIDER), "x".repeat(4096), U64(EXPIRES));
        assert_eq!(id, 0);
    }

    #[test]
    #[should_panic(expected = "future")]
    fn create_job_rejects_past_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(NOW));
    }

    #[test]
    fn create_job_refunds_storage_excess() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        let refund = transfer_to(CLIENT).expect("expected a storage refund to the client");
        assert!(refund.as_yoctonear() > 0, "refund should be positive");
        assert!(
            refund < NearToken::from_near(1),
            "refund must be less than the deposit (storage has a cost)"
        );
    }

    #[test]
    #[should_panic(expected = "does not cover storage")]
    fn create_job_rejects_insufficient_storage_deposit() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_yoctonear(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
    }

    // ---- fund ----

    #[test]
    fn fund_happy() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(7), NOW, Gas::from_tgas(300));
        c.fund(0);
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Funded);
        assert_eq!(job.amount, NearToken::from_near(7));
        assert!(get_logs().iter().any(|l| l.contains("job_funded")));
    }

    #[test]
    #[should_panic(expected = "only the client")]
    fn fund_rejects_non_client() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(RANGER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
    }

    #[test]
    #[should_panic(expected = "not Open")]
    fn fund_rejects_double_fund() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
    }

    #[test]
    #[should_panic(expected = "escrow amount")]
    fn fund_rejects_zero_deposit() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        c.fund(0);
    }

    // ---- submit ----

    #[test]
    fn submit_happy() {
        let c = submitted_job();
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Submitted);
        assert_eq!(job.dh, sha256_hex(DELIVERABLE.as_bytes()));
        assert_eq!(job.deliverable, DELIVERABLE);
        assert!(get_logs().iter().any(|l| l.contains("deliverable_submitted")));
    }

    #[test]
    #[should_panic(expected = "only the provider")]
    fn submit_rejects_non_provider() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(RANGER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
    }

    #[test]
    #[should_panic(expected = "not Funded")]
    fn submit_rejects_before_fund() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
    }

    #[test]
    #[should_panic(expected = "expired")]
    fn submit_rejects_after_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(1), EXPIRES + 1, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
    }

    #[test]
    #[should_panic(expected = "expired")]
    fn submit_rejects_at_exactly_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        // At exactly expires_at_ns the job has expired; submit must be rejected.
        set_ctx(PROVIDER, NearToken::from_near(1), EXPIRES, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
    }

    #[test]
    #[should_panic(expected = "deliverable exceeds")]
    fn submit_rejects_oversized_deliverable() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.submit(0, "x".repeat(16385));
    }

    #[test]
    fn submit_allows_max_deliverable() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.submit(0, "x".repeat(16384));
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
    }

    #[test]
    fn submit_refunds_storage_excess_to_provider() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
        let refund = transfer_to(PROVIDER).expect("expected a storage refund to the provider");
        assert!(refund.as_yoctonear() > 0);
        assert!(refund < NearToken::from_near(1));
    }

    // ---- request_ruling ----

    #[test]
    fn request_ruling_moves_to_ruling_and_bumps_attempt() {
        let c = ruling_job();
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Ruling);
        assert_eq!(job.attempt, U64(1));
        assert!(get_logs().iter().any(|l| l.contains("ruling_requested")));
    }

    #[test]
    #[should_panic(expected = "client or provider")]
    fn request_ruling_rejects_third_party() {
        // Only the parties may ask for a ruling. A third party could otherwise spam failing
        // requests to keep flipping the job between Ruling and Submitted.
        let mut c = submitted_job();
        set_ctx(RANGER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
    }

    #[test]
    fn request_ruling_allowed_for_client() {
        let mut c = submitted_job();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Ruling);
        // The caller is the OutLayer payer, so the client gets any unused deposit back.
        let (_, args, _, _) = fn_call_to(OUTLAYER).expect("a receipt to outlayer");
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args).unwrap();
        assert_eq!(v["payer_account_id"], CLIENT);
    }

    #[test]
    fn request_ruling_allowed_for_provider() {
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Ruling);
    }

    #[test]
    #[should_panic(expected = "not Submitted")]
    fn request_ruling_rejects_when_not_submitted() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
    }

    #[test]
    fn request_ruling_allowed_past_expiry() {
        // Decision: request_ruling has no expiry gate. The deliverable was submitted on time, so a
        // ruling can still be requested after expiry. It races with claim_refund on a Submitted job,
        // resolved by block order; here it succeeds and moves the job to Ruling.
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(1), EXPIRES + 1, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Ruling);
    }

    #[test]
    #[should_panic(expected = "170 TGas")]
    fn request_ruling_rejects_low_gas() {
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(169));
        c.request_ruling(0).detach();
    }

    #[test]
    #[should_panic(expected = "OutLayer payment")]
    fn request_ruling_rejects_zero_deposit() {
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
    }

    #[test]
    fn request_ruling_sends_correct_outlayer_call() {
        let mut c = submitted_job();
        let deposit = NearToken::from_millinear(20);
        set_ctx(PROVIDER, deposit, NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();

        let (method, args, attached, gas) =
            fn_call_to(OUTLAYER).expect("a receipt to outlayer");
        assert_eq!(method, "request_execution");
        assert_eq!(attached, deposit);
        assert_eq!(gas, GAS_OUTLAYER_REQUEST);

        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args).unwrap();
        // source
        assert_eq!(v["source"]["WasmUrl"]["url"], JUDGE_URL);
        assert_eq!(v["source"]["WasmUrl"]["hash"], jhash());
        assert_eq!(v["source"]["WasmUrl"]["build_target"], BUILD_TARGET);
        // resource limits: the values bound by docs/interface.md section 4 (50 billion instructions,
        // 64 MB, 30 s), far above the judge's measured worst valid input (589,750,000 instructions,
        // 1.75 MB, ~21 ms). Literal on purpose, so an accidental change to the constants is caught.
        assert_eq!(v["resource_limits"]["max_instructions"], 50_000_000_000u64);
        assert_eq!(v["resource_limits"]["max_memory_mb"], 64);
        assert_eq!(v["resource_limits"]["max_execution_seconds"], 30);
        // response format is the string "Json"
        assert_eq!(v["response_format"], "Json");
        // payer is the ruling caller
        assert_eq!(v["payer_account_id"], PROVIDER);
        // secrets_ref and params are null
        assert!(v["secrets_ref"].is_null());
        assert!(v["params"].is_null());
        // input_data is the stringified {criteria, deliverable} object
        let input = v["input_data"].as_str().unwrap();
        let inner: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(input).unwrap();
        assert_eq!(inner["criteria"], CRITERIA);
        assert_eq!(inner["deliverable"], DELIVERABLE);
    }

    #[test]
    fn request_ruling_schedules_private_callback() {
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        let (method, args, _dep, gas) = fn_call_to(ESCROW).expect("a callback receipt to self");
        assert_eq!(method, "on_ruling");
        assert_eq!(gas, GAS_ON_RULING);
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args).unwrap();
        assert_eq!(v["job_id"], 0);
        assert_eq!(v["attempt"], 1);
    }

    // ---- on_ruling ----

    #[test]
    fn on_ruling_pass_pays_provider() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &job.ch, &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Completed);
        assert_eq!(transfer_to(PROVIDER), Some(NearToken::from_near(5)));
        assert!(get_logs().iter().any(|l| l.contains("ruling_applied")));
        assert!(get_logs().iter().any(|l| l.contains("completed")));
    }

    #[test]
    fn on_ruling_fail_refunds_client() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(false, &job.ch, &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    fn on_ruling_null_returns_to_submitted() {
        let mut c = ruling_job();
        callback_ctx(vec![PromiseResult::Successful(b"null".to_vec())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
    }

    #[test]
    fn on_ruling_garbage_returns_to_submitted() {
        let mut c = ruling_job();
        callback_ctx(vec![PromiseResult::Successful(b"not even json".to_vec())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
    }

    #[test]
    fn on_ruling_wrong_version_returns_to_submitted() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = format!(
            "{{\"v\":2,\"pass\":true,\"score\":100,\"ch\":\"{}\",\"dh\":\"{}\",\"eh\":\"{}\"}}",
            job.ch,
            job.dh,
            "f".repeat(64)
        );
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
    }

    #[test]
    fn on_ruling_ch_mismatch_returns_to_submitted() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &"b".repeat(64), &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
    }

    #[test]
    fn on_ruling_dh_mismatch_returns_to_submitted() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &job.ch, &"c".repeat(64));
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
    }

    #[test]
    fn on_ruling_failed_promise_returns_to_submitted() {
        let mut c = ruling_job();
        callback_ctx(vec![PromiseResult::Failed]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
        assert!(get_logs().iter().any(|l| l.contains("outlayer_call_failed")));
    }

    #[test]
    fn on_ruling_oversized_returns_to_submitted() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        // A valid-looking verdict (correct hashes) padded past the real cap via a huge eh field. The
        // padding is a FIXED size, not derived from MAX_VERDICT_BYTES, so that raising the cap makes
        // this verdict readable (and wrongly paid) rather than still oversized.
        let big = format!(
            "{{\"v\":1,\"pass\":true,\"score\":100,\"ch\":\"{}\",\"dh\":\"{}\",\"eh\":\"{}\"}}",
            job.ch,
            job.dh,
            "f".repeat(5000)
        );
        callback_ctx(vec![PromiseResult::Successful(big.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
        assert!(get_logs().iter().any(|l| l.contains("verdict_too_large")));
    }

    #[test]
    fn on_ruling_stale_attempt_is_ignored() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &job.ch, &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        // Live attempt is 1; a callback for attempt 0 must change nothing.
        c.on_ruling(0, 0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Ruling);
        assert!(!any_transfer());
    }

    #[test]
    fn on_ruling_on_refunded_job_is_ignored() {
        // Drive to Ruling, then grace-refund, then a late winning verdict must not pay.
        let mut c = ruling_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &job.ch, &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert!(transfer_to(PROVIDER).is_none());
    }

    #[test]
    fn on_ruling_no_double_pay() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &job.ch, &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.clone().into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Completed);
        // A second identical callback must not pay again (state is no longer Ruling).
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Completed);
        assert!(!any_transfer());
    }

    #[test]
    fn ruling_can_be_retried_after_rejection() {
        let mut c = ruling_job();
        callback_ctx(vec![PromiseResult::Successful(b"null".to_vec())]);
        c.on_ruling(0, 1);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        // Second ruling bumps the attempt to 2.
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        assert_eq!(c.get_job(0).unwrap().attempt, U64(2));
    }

    // ---- claim_refund ----

    #[test]
    fn claim_refund_funded_after_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + 1, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    fn claim_refund_funded_exactly_at_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn claim_refund_submitted_rejects_at_expiry() {
        // Delivered work gets a ruling window: a Submitted job is NOT refundable at plain expiry,
        // so a client cannot stall rulings until expires_at and then take the money back.
        let mut c = submitted_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn claim_refund_submitted_rejects_before_grace() {
        let mut c = submitted_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS - 1, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    #[test]
    fn claim_refund_submitted_after_grace() {
        let mut c = submitted_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn claim_refund_rejects_before_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(RANGER, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    #[test]
    fn claim_refund_ruling_after_grace() {
        let mut c = ruling_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn claim_refund_ruling_rejects_before_grace() {
        let mut c = ruling_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS - 1, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn claim_refund_rejects_open() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + 1, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn claim_refund_rejects_completed() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let verdict = valid_verdict(true, &job.ch, &job.dh);
        callback_ctx(vec![PromiseResult::Successful(verdict.into_bytes())]);
        c.on_ruling(0, 1);
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    #[test]
    fn claim_refund_money_goes_to_client_not_caller() {
        let mut c = submitted_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
        assert!(transfer_to(RANGER).is_none());
    }

    #[test]
    #[should_panic(expected = "not Submitted")]
    fn race_refund_first_then_ruling_rejected() {
        // Past expiry + grace both paths are open and block order decides. The refund lands first:
        // the job is Refunded, so a ruling request that lands after it is rejected.
        let mut c = submitted_job();
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.claim_refund(0);
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        set_ctx(PROVIDER, NearToken::from_near(1), EXPIRES + GRACE_NS, Gas::from_tgas(300));
        c.request_ruling(0).detach();
    }

    #[test]
    #[should_panic(expected = "not refundable")]
    fn race_ruling_first_then_refund_rejected_within_grace() {
        // Inside the grace window a ruling can still be requested. Once it lands the job is Ruling,
        // and the client cannot refund until expiry + grace.
        let mut c = submitted_job();
        set_ctx(PROVIDER, NearToken::from_near(1), EXPIRES + 1, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Ruling);
        set_ctx(RANGER, NearToken::from_near(0), EXPIRES + 1, Gas::from_tgas(300));
        c.claim_refund(0);
    }

    // ---- views + serialization ----

    #[test]
    fn get_job_none_for_missing() {
        let c = new_contract();
        assert!(c.get_job(42).is_none());
    }

    #[test]
    fn list_jobs_paginates() {
        let mut c = new_contract();
        for _ in 0..3 {
            set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
            c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES));
        }
        assert_eq!(c.list_jobs(None, None).len(), 3);
        assert_eq!(c.list_jobs(Some(1), Some(1)).len(), 1);
        assert_eq!(c.list_jobs(Some(1), Some(1))[0].client, acc(CLIENT));
        assert_eq!(c.list_jobs(Some(5), Some(10)).len(), 0);
    }

    #[test]
    fn execution_source_json_matches_interface() {
        let s = ExecutionSource::WasmUrl {
            url: "https://x/j.wasm".to_string(),
            hash: "a".repeat(64),
            build_target: Some("wasm32-wasip1".to_string()),
        };
        let j = near_sdk::serde_json::to_string(&s).unwrap();
        assert_eq!(
            j,
            format!(
                "{{\"WasmUrl\":{{\"url\":\"https://x/j.wasm\",\"hash\":\"{}\",\"build_target\":\"wasm32-wasip1\"}}}}",
                "a".repeat(64)
            )
        );
    }

    #[test]
    fn resource_limits_json_shape() {
        let l = ResourceLimits {
            max_instructions: Some(1_000_000_000),
            max_memory_mb: Some(64),
            max_execution_seconds: Some(30),
        };
        let j = near_sdk::serde_json::to_string(&l).unwrap();
        assert_eq!(
            j,
            "{\"max_instructions\":1000000000,\"max_memory_mb\":64,\"max_execution_seconds\":30}"
        );
    }

    #[test]
    fn response_format_json_is_string() {
        let j = near_sdk::serde_json::to_string(&ResponseFormat::Json).unwrap();
        assert_eq!(j, "\"Json\"");
    }

    #[test]
    fn is_64_lower_hex_rules() {
        assert!(is_64_lower_hex(&"a".repeat(64)));
        assert!(is_64_lower_hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assert!(!is_64_lower_hex(&"a".repeat(63)));
        assert!(!is_64_lower_hex(&"a".repeat(65)));
        assert!(!is_64_lower_hex(&"A".repeat(64)));
        assert!(!is_64_lower_hex(&"g".repeat(64)));
    }
}
