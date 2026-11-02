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
/// Max length of a sealed deliverable's ciphertext C in base64 characters (interface.md 6.1): a
/// 16,384-byte plaintext plus a 12-byte nonce and a 16-byte tag.
const MAX_DELIVERABLE_CT_BYTES: usize = 21_884;
/// A well formed k (interface.md 6.3): 124 characters of standard base64 that decode to 93 bytes
/// starting with the version byte 0x01.
const K_B64_LEN: usize = 124;
const K_RAW_LEN: usize = 93;
const K_VERSION_BYTE: u8 = 0x01;
/// Storing k in on_ruling turns the job's `k: None` into `Some(k)`: a u32 length prefix plus the 124
/// characters, 128 bytes. The callback cannot take a deposit, so submit_sealed charges the provider
/// for these bytes up front and the contract keeps them as storage stake. Without this, a contract
/// with no spare balance would fail the callback on storage staking and leave a passing provider
/// unpaid.
const K_STORAGE_RESERVE_BYTES: u64 = 4 + K_B64_LEN as u64;

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

/// Resource limits sent to OutLayer: 50 billion instructions, 64 MB, 30 seconds (bound by
/// docs/interface.md section 4).
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

/// Reference to a stored secrets profile, field names and types matched to OutLayer's
/// SecretsReference (contract/src/lib.rs): the profile name and the account that owns the secret.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SecretsReference {
    pub profile: String,
    pub account_id: AccountId,
}

/// The OutLayer method we call. The argument order and names match OutLayer exactly so NEAR's
/// cross-contract JSON object (keys = parameter names) deserializes there. secrets_ref is null for a
/// public job and names the provider's key for a sealed job (interface.md 6.2). params is always
/// None (null); its inner type is irrelevant to a null value.
#[ext_contract(ext_outlayer)]
pub trait OutLayer {
    fn request_execution(
        &mut self,
        source: ExecutionSource,
        resource_limits: Option<ResourceLimits>,
        input_data: Option<String>,
        secrets_ref: Option<SecretsReference>,
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
    /// sha256 hex of the deliverable bytes (empty until submit). For a sealed job it is the
    /// provider's commitment to the plaintext, checked by the judge.
    pub dh: String,
    /// Sealed jobs only: the client's X25519 public key, 64 lowercase hex. Some = sealed.
    pub client_pk: Option<String>,
    /// Sealed jobs only: the deliverable ciphertext C, standard base64 (empty until submit_sealed).
    pub deliverable_ct: String,
    /// Sealed jobs only: K sealed to client_pk, stored by the callback that pays the provider.
    pub k: Option<String>,
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
    pub sealed: bool,
    pub client_pk: Option<String>,
    pub deliverable_ct: String,
    /// null until a sealed pass.
    pub k: Option<String>,
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
            sealed: j.client_pk.is_some(),
            client_pk: j.client_pk.clone(),
            deliverable_ct: j.deliverable_ct.clone(),
            k: j.k.clone(),
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
    /// refunded. The deposit here is storage only, never escrow. Passing client_pk (the client's
    /// X25519 public key, 64 lowercase hex) makes it a sealed job (interface.md section 6).
    #[payable]
    pub fn create_job(
        &mut self,
        provider: AccountId,
        criteria: String,
        expires_at_ns: U64,
        client_pk: Option<String>,
    ) -> u64 {
        let client = env::predecessor_account_id();
        require!(provider != client, "provider must differ from client");
        require!(
            criteria.len() <= MAX_CRITERIA_BYTES,
            "criteria exceeds 4096 bytes"
        );
        let now = env::block_timestamp();
        let expires = expires_at_ns.0;
        require!(expires > now, "expires_at_ns must be in the future");
        if let Some(pk) = client_pk.as_deref() {
            let mut key = [0u8; 32];
            require!(
                is_64_lower_hex(pk) && hex::decode_to_slice(pk, &mut key).is_ok(),
                "client_pk must be 64 lowercase hex characters"
            );
            // With a small-order key the judge's shared secret is all zeros and anyone could open k.
            require!(!is_small_order(&key), "client_pk is a small-order X25519 point");
        }

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
            client_pk: client_pk.clone(),
            deliverable_ct: String::new(),
            k: None,
            amount: NearToken::from_yoctonear(0),
            state: JobState::Open,
            expires_at_ns: expires,
            attempt: 0,
            created_at_ns: now,
        };
        self.jobs.insert(id, job);
        self.next_id += 1;
        self.jobs.flush();
        charge_storage(before, &client, 0);
        event_job_created(id, &client, &provider, &ch, expires, client_pk.is_some());
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
            require_can_submit(job);
            require!(job.client_pk.is_none(), "job is sealed: use submit_sealed");
            provider = job.provider.clone();
            job.deliverable = deliverable;
            record_submission(job, &dh);
        }
        self.jobs.flush();
        charge_storage(before, &provider, 0);
        event_deliverable_submitted(job_id, &dh);
    }

    /// Submit a sealed deliverable (interface.md 6.1): the ciphertext C (standard base64, at most
    /// 21,884 characters) and dh, the provider's commitment to sha256 of the plaintext, which the
    /// judge checks after decrypting. Sealed jobs only. The storage deposit also covers the k that a
    /// pass will store later (K_STORAGE_RESERVE_BYTES); the rest is refunded.
    #[payable]
    pub fn submit_sealed(&mut self, job_id: u64, deliverable_ct: String, dh: String) {
        require!(
            deliverable_ct.len() <= MAX_DELIVERABLE_CT_BYTES,
            "deliverable_ct exceeds 21884 bytes"
        );
        require!(is_64_lower_hex(&dh), "dh must be 64 lowercase hex characters");
        let before = env::storage_usage();
        let provider;
        {
            let job = self.jobs.get_mut(&job_id).expect("no such job");
            require_can_submit(job);
            require!(job.client_pk.is_some(), "job is not sealed: use submit");
            provider = job.provider.clone();
            job.deliverable_ct = deliverable_ct;
            record_submission(job, &dh);
        }
        self.jobs.flush();
        charge_storage(before, &provider, K_STORAGE_RESERVE_BYTES);
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

        let attempt;
        let snapshot;
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
            snapshot = job.clone();
        }

        // input_data is the stdin of the judge WASM: the public object of interface.md section 1, or
        // the sealed object of 6.3, built from the exact stored strings. A sealed job also names the
        // provider's key in secrets_ref (6.2); the provider owns that secret whoever asks.
        let (input_data, secrets_ref) = match snapshot.client_pk.as_deref() {
            None => (public_input(&snapshot), None),
            Some(client_pk) => (
                sealed_input(&snapshot, client_pk),
                Some(SecretsReference {
                    profile: secrets_profile(&env::current_account_id(), job_id),
                    account_id: snapshot.provider.clone(),
                }),
            ),
        };

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
                secrets_ref,
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
                Some(v) => self.apply_verdict(job_id, &job, v),
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

    /// The OutLayer secrets profile under which the provider stores `{"JN_KEY": ...}` for a sealed
    /// job (interface.md 6.2). The escrow is the only party that ever names it in secrets_ref.
    /// None for a public or unknown job.
    pub fn get_secrets_profile(&self, job_id: u64) -> Option<String> {
        let job = self.jobs.get(&job_id)?;
        job.client_pk.as_ref()?;
        Some(secrets_profile(&env::current_account_id(), job_id))
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

    /// Apply a verdict that passed the v/ch/dh/attempt checks (interface.md sections 4 and 6.4).
    fn apply_verdict(&mut self, job_id: u64, job: &Job, v: ParsedVerdict) {
        let sealed = job.client_pk.is_some();
        // Sealed rule: the run could not read JN_KEY. No money moves; the provider can store the key
        // and the job can be ruled again. Checked before pass, because this verdict has pass:false
        // and must not refund.
        if sealed && v.err.as_deref() == Some("key_missing") {
            self.set_state(job_id, JobState::Submitted);
            event_ruling_rejected(job_id, "key_missing");
            return;
        }
        if !v.pass {
            // Applied as written: pass:false (including bad_delivery) refunds the client.
            self.set_state(job_id, JobState::Refunded);
            event_ruling_applied(job_id, false, v.score, &v.eh, None);
            event_refunded(job_id, &job.client, job.amount);
            Promise::new(job.client.clone())
                .transfer(job.amount)
                .detach();
            return;
        }
        // A sealed pass is applied only with a well formed k; public jobs ignore k.
        let k = if sealed {
            match v.k.filter(|k| is_valid_k(k)) {
                Some(k) => Some(k),
                None => {
                    self.set_state(job_id, JobState::Submitted);
                    event_ruling_rejected(job_id, "invalid_k");
                    return;
                }
            }
        } else {
            None
        };
        // State and k before the transfer, in the same callback. Completed closes the job to any
        // further payout, so k can only ever be written once (the reserve covers that one write).
        if let Some(stored) = self.jobs.get_mut(&job_id) {
            stored.state = JobState::Completed;
            stored.k = k.clone();
        }
        event_ruling_applied(job_id, true, v.score, &v.eh, k.as_deref());
        event_completed(job_id, &job.provider, job.amount);
        Promise::new(job.provider.clone())
            .transfer(job.amount)
            .detach();
    }

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

/// libsodium's blocklist of small-order X25519 points (`has_small_order` in
/// crypto_scalarmult/curve25519/ref10/x25519_ref10.c). With such a client_pk the shared secret the
/// judge derives for `k` is all zeros, so anyone could open `k` (interface.md 6.4). The bytes are
/// proven by a unit test against x25519-dalek: X25519 of each entry with any scalar is all zeros.
const SMALL_ORDER_POINTS: [[u8; 32]; 7] = [
    // 0 (order 4)
    [0; 32],
    // 1 (order 1)
    [
        0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0,
    ],
    // order 8
    [
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,
        0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49,
        0xb8, 0x00,
    ],
    // order 8
    [
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef,
        0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f,
        0x11, 0x57,
    ],
    // p - 1 (order 2)
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // p (= 0, order 4)
    [
        0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // p + 1 (= 1, order 1)
    [
        0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
];

/// libsodium's comparison: the first 31 bytes exactly, and the last byte with its top bit masked
/// off (X25519 ignores bit 255, so a key with that bit set is the same point).
fn is_small_order(pk: &[u8; 32]) -> bool {
    SMALL_ORDER_POINTS
        .iter()
        .any(|e| pk[..31] == e[..31] && (pk[31] & 0x7f) == e[31])
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(env::sha256(bytes))
}

/// The judge's stdin for a public job (interface.md section 1). Serialized to a String because
/// OutLayer's input_data is Option<String>.
fn public_input(job: &Job) -> String {
    near_sdk::serde_json::json!({
        "criteria": job.criteria.as_str(),
        "deliverable": job.deliverable.as_str(),
    })
    .to_string()
}

/// The judge's stdin for a sealed job (interface.md 6.3). No `deliverable` key: its presence next to
/// `deliverable_ct` makes the judge answer invalid_input.
fn sealed_input(job: &Job, client_pk: &str) -> String {
    near_sdk::serde_json::json!({
        "criteria": &job.criteria,
        "deliverable_ct": &job.deliverable_ct,
        "dh": &job.dh,
        "client_pk": client_pk,
    })
    .to_string()
}

/// The OutLayer secrets profile for a sealed job (interface.md 6.2): "jn-" + the first 16 hex of
/// sha256(escrow account id) + "-" + job id. At most 40 bytes of letters, digits and '-', inside
/// OutLayer's profile rule (1 to 64 bytes of alphanumerics, '-' or '_').
fn secrets_profile(escrow: &AccountId, job_id: u64) -> String {
    let h = sha256_hex(escrow.as_bytes());
    format!("jn-{}-{}", &h[..16], job_id)
}

/// Checks shared by submit and submit_sealed: only the provider, only when Funded, strictly before
/// expiry.
fn require_can_submit(job: &Job) {
    require!(
        env::predecessor_account_id() == job.provider,
        "only the provider can submit"
    );
    require!(job.state == JobState::Funded, "job is not Funded");
    require!(
        env::block_timestamp() < job.expires_at_ns,
        "job has expired"
    );
}

/// Bookkeeping shared by submit and submit_sealed: record the deliverable hash and move to Submitted.
fn record_submission(job: &mut Job, dh: &str) {
    job.dh = dh.to_string();
    job.state = JobState::Submitted;
}

/// Charge the deposit for the storage used since `before` (the collection must be flushed first)
/// plus `extra_bytes` reserved for a later write, and refund any excess to `payer`. Panics
/// (reverting all state) if the deposit is short.
fn charge_storage(before: u64, payer: &AccountId, extra_bytes: u64) {
    let used = env::storage_usage()
        .saturating_sub(before)
        .saturating_add(extra_bytes);
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
    err: Option<String>,
    k: Option<String>,
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
        err: v.err,
        k: v.k,
    })
}

/// The verdict fields the contract reads, by name (OutLayer re-serializes the judge's JSON with the
/// keys sorted, interface.md 6.5). err and k are optional (sections 3 and 6.3).
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
    err: Option<String>,
    #[serde(default)]
    k: Option<String>,
    #[serde(default)]
    eh: String,
}

/// interface.md 6.3: a well formed k is 124 characters of standard base64 that decode to 93 bytes
/// starting with the version byte 0x01. Decoded with the base64 crate near-sdk already ships.
fn is_valid_k(k: &str) -> bool {
    use near_sdk::base64::{Engine as _, engine::general_purpose::STANDARD};
    k.len() == K_B64_LEN
        && STANDARD
            .decode(k)
            .is_ok_and(|raw| raw.len() == K_RAW_LEN && raw[0] == K_VERSION_BYTE)
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

fn event_job_created(
    id: u64,
    client: &AccountId,
    provider: &AccountId,
    ch: &str,
    expires: u64,
    sealed: bool,
) {
    emit(
        "job_created",
        near_sdk::serde_json::json!({
            "job_id": id,
            "client": client.as_str(),
            "provider": provider.as_str(),
            "ch": ch,
            "expires_at_ns": expires.to_string(),
            "sealed": sealed,
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

/// `k` is the sealed key for the client on a sealed pass (interface.md 6.4), null otherwise.
fn event_ruling_applied(id: u64, pass: bool, score: u8, eh: &str, k: Option<&str>) {
    emit(
        "ruling_applied",
        near_sdk::serde_json::json!({
            "job_id": id,
            "pass": pass,
            "score": score,
            "eh": eh,
            "k": k,
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
        let id = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        let id = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        let a = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let b = c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        assert_eq!((a, b), (0, 1));
    }

    #[test]
    #[should_panic(expected = "provider must differ")]
    fn create_job_rejects_self_dealing() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(CLIENT), CRITERIA.to_string(), U64(EXPIRES), None);
    }

    #[test]
    #[should_panic(expected = "criteria exceeds")]
    fn create_job_rejects_oversized_criteria() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), "x".repeat(4097), U64(EXPIRES), None);
    }

    #[test]
    fn create_job_allows_max_criteria() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let id = c.create_job(acc(PROVIDER), "x".repeat(4096), U64(EXPIRES), None);
        assert_eq!(id, 0);
    }

    #[test]
    #[should_panic(expected = "future")]
    fn create_job_rejects_past_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(NOW), None);
    }

    #[test]
    fn create_job_refunds_storage_excess() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
    }

    // ---- fund ----

    #[test]
    fn fund_happy() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        set_ctx(RANGER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
    }

    #[test]
    #[should_panic(expected = "not Open")]
    fn fund_rejects_double_fund() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
    }

    #[test]
    #[should_panic(expected = "expired")]
    fn submit_rejects_after_expiry() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.submit(0, "x".repeat(16385));
    }

    #[test]
    fn submit_allows_max_deliverable() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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
            c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
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

    // ---- sealed mode: small-order X25519 blocklist (oracle: x25519-dalek, dev-only) ----

    #[test]
    fn small_order_blocklist_matches_x25519_oracle() {
        // x25519 clamps the scalar (clears its low 3 bits), so any 32 bytes are a valid scalar and
        // the clamped value is a multiple of the cofactor 8. Every small-order point is therefore
        // sent to the identity, which X25519 outputs as 32 zero bytes. Each blocklist entry, and its
        // variant with the top bit set (X25519 ignores bit 255), must give an all-zero output.
        let scalar = [0x42u8; 32];
        for entry in SMALL_ORDER_POINTS.iter() {
            assert_eq!(x25519_dalek::x25519(scalar, *entry), [0u8; 32], "entry {entry:02x?}");
            let mut high = *entry;
            high[31] |= 0x80;
            assert_eq!(x25519_dalek::x25519(scalar, high), [0u8; 32], "high {high:02x?}");
        }
    }

    #[test]
    fn normal_key_is_not_small_order() {
        let pk = x25519_dalek::x25519([7u8; 32], x25519_dalek::X25519_BASEPOINT_BYTES);
        assert!(!is_small_order(&pk));
        // Second oracle: the same scalar gives a non-zero shared secret with a normal key.
        assert_ne!(x25519_dalek::x25519([0x42u8; 32], pk), [0u8; 32]);
    }

    #[test]
    fn is_small_order_flags_every_entry_and_its_high_bit_variant() {
        assert_eq!(SMALL_ORDER_POINTS.len(), 7);
        for entry in SMALL_ORDER_POINTS.iter() {
            assert!(is_small_order(entry), "entry {entry:02x?}");
            let mut high = *entry;
            high[31] |= 0x80;
            assert!(is_small_order(&high), "libsodium masks the last byte with 0x7f");
        }
    }

    // ---- sealed mode helpers: the judge's real vectors (judge-wasm/vectors/sealed.json) ----

    const SEALED_VECTORS: &str = include_str!("../../judge-wasm/vectors/sealed.json");

    struct Vector {
        criteria: String,
        deliverable_ct: String,
        dh: String,
        client_pk: String,
        expected: String,
    }

    fn vector(i: usize) -> Vector {
        let all: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(SEALED_VECTORS).unwrap();
        let stdin: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(all[i]["stdin"].as_str().unwrap()).unwrap();
        Vector {
            criteria: stdin["criteria"].as_str().unwrap().to_string(),
            deliverable_ct: stdin["deliverable_ct"].as_str().unwrap().to_string(),
            dh: stdin["dh"].as_str().unwrap().to_string(),
            client_pk: stdin["client_pk"].as_str().unwrap().to_string(),
            expected: all[i]["expected"].as_str().unwrap().to_string(),
        }
    }

    fn sealed_funded_job(v: &Vector) -> Contract {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), v.criteria.clone(), U64(EXPIRES), Some(v.client_pk.clone()));
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        c
    }

    fn sealed_submitted_job(v: &Vector) -> Contract {
        let mut c = sealed_funded_job(v);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct.clone(), v.dh.clone());
        c
    }

    // ---- sealed mode: create_job ----

    #[test]
    fn create_job_sealed_marks_job_and_stores_client_pk() {
        let v = vector(0);
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), v.criteria.clone(), U64(EXPIRES), Some(v.client_pk.clone()));
        assert!(get_logs().iter().any(|l| l.contains("job_created") && l.contains("\"sealed\":true")));
        let job = c.get_job(0).unwrap();
        assert!(job.sealed);
        assert_eq!(job.client_pk, Some(v.client_pk));
        assert_eq!(job.deliverable_ct, "");
        assert_eq!(job.k, None);
    }

    #[test]
    fn create_job_public_is_not_sealed() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        assert!(get_logs().iter().any(|l| l.contains("job_created") && l.contains("\"sealed\":false")));
        let job = c.get_job(0).unwrap();
        assert!(!job.sealed);
        assert_eq!(job.client_pk, None);
    }

    #[test]
    fn create_job_accepts_a_normal_key() {
        let pk = hex::encode(x25519_dalek::x25519([7u8; 32], x25519_dalek::X25519_BASEPOINT_BYTES));
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), Some(pk.clone()));
        assert_eq!(c.get_job(0).unwrap().client_pk, Some(pk));
    }

    #[test]
    #[should_panic(expected = "client_pk must be 64 lowercase hex")]
    fn create_job_rejects_uppercase_client_pk() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), Some("AB".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "client_pk must be 64 lowercase hex")]
    fn create_job_rejects_short_client_pk() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), Some("ab".repeat(31)));
    }

    #[test]
    #[should_panic(expected = "small-order")]
    fn create_job_rejects_small_order_client_pk() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let pk = hex::encode(SMALL_ORDER_POINTS[2]);
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), Some(pk));
    }

    #[test]
    #[should_panic(expected = "small-order")]
    fn create_job_rejects_small_order_client_pk_with_high_bit() {
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        let mut e = SMALL_ORDER_POINTS[3];
        e[31] |= 0x80;
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), Some(hex::encode(e)));
    }

    // ---- sealed mode: submit_sealed ----

    #[test]
    fn submit_sealed_happy() {
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct.clone(), v.dh.clone());
        assert!(get_logs().iter().any(|l| l.contains("deliverable_submitted")));
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Submitted);
        assert_eq!(job.deliverable_ct, v.deliverable_ct);
        assert_eq!(job.dh, v.dh);
        assert_eq!(job.deliverable, "");
    }

    #[test]
    #[should_panic(expected = "not sealed")]
    fn submit_sealed_rejects_public_job() {
        let v = vector(0);
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), CRITERIA.to_string(), U64(EXPIRES), None);
        set_ctx(CLIENT, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.fund(0);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh);
    }

    #[test]
    #[should_panic(expected = "is sealed")]
    fn submit_rejects_sealed_job() {
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit(0, DELIVERABLE.to_string());
    }

    #[test]
    #[should_panic(expected = "only the provider")]
    fn submit_sealed_rejects_non_provider() {
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        set_ctx(RANGER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh);
    }

    #[test]
    #[should_panic(expected = "not Funded")]
    fn submit_sealed_rejects_when_not_funded() {
        let v = vector(0);
        let mut c = new_contract();
        set_ctx(CLIENT, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.create_job(acc(PROVIDER), v.criteria.clone(), U64(EXPIRES), Some(v.client_pk.clone()));
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh);
    }

    #[test]
    #[should_panic(expected = "expired")]
    fn submit_sealed_rejects_at_expiry() {
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(1), EXPIRES, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh);
    }

    #[test]
    fn submit_sealed_allows_max_ct() {
        // Vector 5: a 16384-byte plaintext gives a ciphertext of exactly 21884 base64 characters.
        let v = vector(5);
        assert_eq!(v.deliverable_ct.len(), 21_884);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct.clone(), v.dh.clone());
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
    }

    #[test]
    #[should_panic(expected = "deliverable_ct exceeds")]
    fn submit_sealed_rejects_oversized_ct() {
        // Vector 40: 21885 characters, one past the limit.
        let v = vector(40);
        assert_eq!(v.deliverable_ct.len(), 21_885);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(5), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh);
    }

    #[test]
    #[should_panic(expected = "dh must be 64 lowercase hex")]
    fn submit_sealed_rejects_uppercase_dh() {
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh.to_uppercase());
    }

    #[test]
    #[should_panic(expected = "dh must be 64 lowercase hex")]
    fn submit_sealed_rejects_short_dh() {
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.submit_sealed(0, v.deliverable_ct, v.dh[..63].to_string());
    }

    #[test]
    fn submit_sealed_charges_storage_plus_k_reserve() {
        // The provider pays for what submit_sealed stores AND for the k that a pass will store
        // later in the callback, where no deposit can be attached.
        let v = vector(0);
        let mut c = sealed_funded_job(&v);
        let deposit = NearToken::from_near(1);
        set_ctx(PROVIDER, deposit, NOW, Gas::from_tgas(300));
        let before = env::storage_usage();
        c.submit_sealed(0, v.deliverable_ct.clone(), v.dh.clone());
        let after = env::storage_usage();
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let kept = deposit.as_yoctonear() - transfer_to(PROVIDER).unwrap().as_yoctonear();
        let expected = (u128::from(after - before) + u128::from(K_STORAGE_RESERVE_BYTES)) * byte_cost;
        assert_eq!(kept, expected);
    }

    // ---- sealed mode: request_ruling and the secrets profile ----

    fn sealed_request_args(v: &Vector, caller: &str) -> near_sdk::serde_json::Value {
        let mut c = sealed_submitted_job(v);
        set_ctx(caller, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        let (method, args, _, _) = fn_call_to(OUTLAYER).expect("a receipt to outlayer");
        assert_eq!(method, "request_execution");
        near_sdk::serde_json::from_slice(&args).unwrap()
    }

    #[test]
    fn request_ruling_sealed_sends_sealed_input() {
        let v = vector(0);
        let args = sealed_request_args(&v, PROVIDER);
        let input: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
        let mut keys: Vec<&str> = input.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        // Exactly the sealed stdin of interface.md 6.3: no `deliverable` key.
        assert_eq!(keys, ["client_pk", "criteria", "deliverable_ct", "dh"]);
        assert_eq!(input["criteria"], v.criteria);
        assert_eq!(input["deliverable_ct"], v.deliverable_ct);
        assert_eq!(input["dh"], v.dh);
        assert_eq!(input["client_pk"], v.client_pk);
    }

    #[test]
    fn request_ruling_sealed_names_the_providers_secret() {
        let args = sealed_request_args(&vector(0), PROVIDER);
        assert_eq!(
            args["secrets_ref"],
            near_sdk::serde_json::json!({ "profile": "jn-a3ceca2d26bd216d-0", "account_id": PROVIDER })
        );
    }

    #[test]
    fn request_ruling_sealed_by_client_still_names_the_providers_secret() {
        // The key belongs to the provider, whoever asks for the ruling.
        let args = sealed_request_args(&vector(0), CLIENT);
        assert_eq!(args["secrets_ref"]["account_id"], PROVIDER);
        assert_eq!(args["payer_account_id"], CLIENT);
    }

    #[test]
    fn get_secrets_profile_for_sealed_job() {
        let c = sealed_submitted_job(&vector(0));
        // sha256("escrow.near") starts a3ceca2d26bd216d, computed independently of the contract.
        assert_eq!(c.get_secrets_profile(0), Some("jn-a3ceca2d26bd216d-0".to_string()));
    }

    #[test]
    fn get_secrets_profile_none_for_public_or_missing_job() {
        let c = submitted_job();
        assert_eq!(c.get_secrets_profile(0), None);
        assert_eq!(c.get_secrets_profile(99), None);
    }

    #[test]
    fn secrets_profile_fits_outlayer_profile_rule() {
        // OutLayer refuses a secrets_ref whose profile is not 1 to 64 bytes of alphanumerics, '-'
        // or '_' (secrets.rs profile_shape_error). The longest possible job id still fits.
        set_ctx(ESCROW, NearToken::from_near(0), NOW, Gas::from_tgas(300));
        let p = secrets_profile(&acc(ESCROW), u64::MAX);
        assert_eq!(p.len(), 40);
        assert!(p.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }

    // ---- sealed mode: on_ruling with the judge's real verdicts ----

    type JsonMap = std::collections::BTreeMap<String, near_sdk::serde_json::Value>;

    /// The verdict bytes as OutLayer delivers them (interface.md 6.5): re-serialized with the keys
    /// sorted. A BTreeMap sorts whatever serde_json features the build enables.
    fn as_outlayer_delivers(verdict: &str) -> Vec<u8> {
        let m: JsonMap = near_sdk::serde_json::from_str(verdict).unwrap();
        near_sdk::serde_json::to_vec(&m).unwrap()
    }

    /// A verdict with its k replaced (Some) or removed (None), delivered with sorted keys.
    fn with_k(verdict: &str, k: Option<&str>) -> Vec<u8> {
        let mut m: JsonMap = near_sdk::serde_json::from_str(verdict).unwrap();
        match k {
            Some(k) => m.insert("k".to_string(), near_sdk::serde_json::Value::String(k.to_string())),
            None => m.remove("k"),
        };
        near_sdk::serde_json::to_vec(&m).unwrap()
    }

    fn vector_k(v: &Vector) -> String {
        let m: JsonMap = near_sdk::serde_json::from_str(&v.expected).unwrap();
        m["k"].as_str().unwrap().to_string()
    }

    fn sealed_ruling_job(v: &Vector) -> Contract {
        let mut c = sealed_submitted_job(v);
        set_ctx(PROVIDER, NearToken::from_near(1), NOW, Gas::from_tgas(300));
        c.request_ruling(0).detach();
        c
    }

    fn rule(c: &mut Contract, verdict_bytes: Vec<u8>) {
        callback_ctx(vec![PromiseResult::Successful(verdict_bytes)]);
        c.on_ruling(0, 1);
    }

    #[test]
    fn outlayer_sorted_verdict_parses_like_canonical() {
        let v = vector(0);
        let sorted = as_outlayer_delivers(&v.expected);
        assert_ne!(sorted.as_slice(), v.expected.as_bytes(), "keys must come out reordered");
        let a: VerdictJson = near_sdk::serde_json::from_slice(&sorted).unwrap();
        let b: VerdictJson = near_sdk::serde_json::from_str(&v.expected).unwrap();
        assert_eq!((a.pass, a.k.clone(), a.err.clone()), (b.pass, b.k.clone(), b.err.clone()));
        assert_eq!(a.k.as_deref(), Some(vector_k(&v).as_str()));
    }

    #[test]
    fn is_valid_k_accepts_real_k_and_rejects_malformed() {
        let k = vector_k(&vector(0));
        assert!(is_valid_k(&k));
        assert!(!is_valid_k(&k[..123]));
        assert!(!is_valid_k(&format!("{k}A")));
        let mut bad_char = k.clone();
        bad_char.replace_range(10..11, "!");
        assert!(!is_valid_k(&bad_char));
        let mut url_safe = k.clone();
        url_safe.replace_range(10..11, "-");
        assert!(!is_valid_k(&url_safe), "URL-safe alphabet is not standard base64");
        let padded = format!("{}==", &k[..122]);
        assert!(!is_valid_k(&padded), "embedded padding decodes to fewer than 93 bytes");
        use near_sdk::base64::Engine as _;
        let mut raw = near_sdk::base64::engine::general_purpose::STANDARD.decode(&k).unwrap();
        raw[0] = 0x02;
        let wrong_version = near_sdk::base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(wrong_version.len(), 124);
        assert!(!is_valid_k(&wrong_version));
    }

    #[test]
    fn sealed_pass_with_valid_k_pays_provider_and_stores_k() {
        let v = vector(0);
        let k = vector_k(&v);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, as_outlayer_delivers(&v.expected));
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Completed);
        assert_eq!(job.k, Some(k.clone()));
        assert_eq!(transfer_to(PROVIDER), Some(NearToken::from_near(5)));
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("ruling_applied") && l.contains(&format!("\"k\":\"{k}\""))));
    }

    #[test]
    fn sealed_longest_verdict_is_accepted() {
        // Vector 9: the longest legal verdict (16 checks, with k) is 897 bytes, under the cap.
        let v = vector(9);
        assert_eq!(v.expected.len(), 897);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, as_outlayer_delivers(&v.expected));
        assert_eq!(c.get_job(0).unwrap().state, JobState::Completed);
        assert_eq!(transfer_to(PROVIDER), Some(NearToken::from_near(5)));
    }

    #[test]
    fn sealed_key_missing_returns_to_submitted() {
        // Vector 15: JN_KEY absent. No money moves; the provider can store the key and retry.
        let v = vector(15);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, as_outlayer_delivers(&v.expected));
        assert_eq!(c.get_job(0).unwrap().state, JobState::Submitted);
        assert!(!any_transfer());
        assert!(get_logs().iter().any(|l| l.contains("ruling_rejected") && l.contains("key_missing")));
    }

    #[test]
    fn sealed_bad_delivery_refunds_client() {
        // Vector 20: wrong key. Applied as written: pass:false refunds the client.
        let v = vector(20);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, as_outlayer_delivers(&v.expected));
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Refunded);
        assert_eq!(job.k, None);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    fn sealed_plain_fail_refunds_client() {
        let v = vector(10);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, as_outlayer_delivers(&v.expected));
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    fn sealed_invalid_criteria_refunds_client() {
        let v = vector(12);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, as_outlayer_delivers(&v.expected));
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    fn sealed_pass_without_k_returns_to_submitted() {
        let v = vector(0);
        let mut c = sealed_ruling_job(&v);
        rule(&mut c, with_k(&v.expected, None));
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Submitted);
        assert_eq!(job.k, None);
        assert!(!any_transfer());
        assert!(get_logs().iter().any(|l| l.contains("invalid_k")));
    }

    #[test]
    fn sealed_pass_with_malformed_k_returns_to_submitted() {
        let v = vector(0);
        let k = vector_k(&v);
        use near_sdk::base64::Engine as _;
        let mut raw = near_sdk::base64::engine::general_purpose::STANDARD.decode(&k).unwrap();
        raw[0] = 0x02;
        let wrong_version = near_sdk::base64::engine::general_purpose::STANDARD.encode(&raw);
        let mut url_safe = k.clone();
        url_safe.replace_range(10..11, "-");
        for bad in [
            k[..123].to_string(),
            format!("{k}A"),
            url_safe,
            format!("{}==", &k[..122]),
            wrong_version,
        ] {
            let mut c = sealed_ruling_job(&v);
            rule(&mut c, with_k(&v.expected, Some(&bad)));
            let job = c.get_job(0).unwrap();
            assert_eq!(job.state, JobState::Submitted, "k {bad} must not be accepted");
            assert_eq!(job.k, None);
            assert!(!any_transfer());
        }
    }

    #[test]
    fn public_job_ignores_k() {
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let mut m: JsonMap =
            near_sdk::serde_json::from_str(&valid_verdict(true, &job.ch, &job.dh)).unwrap();
        m.insert("k".to_string(), near_sdk::serde_json::Value::String("not a k".to_string()));
        rule(&mut c, near_sdk::serde_json::to_vec(&m).unwrap());
        let job = c.get_job(0).unwrap();
        assert_eq!(job.state, JobState::Completed);
        assert_eq!(job.k, None);
        assert_eq!(transfer_to(PROVIDER), Some(NearToken::from_near(5)));
    }

    #[test]
    fn public_job_key_missing_is_applied_as_written() {
        // key_missing is a sealed-job rule (interface.md 6.4). The public judge never emits it; if a
        // public verdict carried it anyway, it is an ordinary pass:false verdict and refunds.
        let mut c = ruling_job();
        let job = c.get_job(0).unwrap();
        let mut m: JsonMap =
            near_sdk::serde_json::from_str(&valid_verdict(false, &job.ch, &job.dh)).unwrap();
        m.insert("err".to_string(), near_sdk::serde_json::Value::String("key_missing".to_string()));
        rule(&mut c, near_sdk::serde_json::to_vec(&m).unwrap());
        assert_eq!(c.get_job(0).unwrap().state, JobState::Refunded);
        assert_eq!(transfer_to(CLIENT), Some(NearToken::from_near(5)));
    }

    #[test]
    fn k_write_grows_storage_by_exactly_the_reserve() {
        // Pins K_STORAGE_RESERVE_BYTES to reality: the reserve charged at submit_sealed is exactly
        // what storing k costs in the callback.
        let v = vector(0);
        let mut c = sealed_ruling_job(&v);
        c.jobs.flush();
        callback_ctx(vec![PromiseResult::Successful(as_outlayer_delivers(&v.expected))]);
        let before = env::storage_usage();
        c.on_ruling(0, 1);
        c.jobs.flush();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Completed);
        assert_eq!(env::storage_usage() - before, K_STORAGE_RESERVE_BYTES);
    }

    #[test]
    fn largest_sealed_pass_fits_the_callback_gas() {
        // Vector 5: the largest sealed job (21,884-character ciphertext) on the heaviest callback
        // path, a pass that stores k. The contract is persisted and reloaded so the job is read from
        // storage as on chain, and the final state write is flushed inside the metered call, which
        // runs with exactly GAS_ON_RULING. The unit VM meters host calls (storage, logs, promises)
        // but not wasm instructions, so this is a lower bound, not a proof.
        let v = vector(5);
        let mut c = sealed_ruling_job(&v);
        c.jobs.flush();
        env::state_write(&c);
        drop(c);
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(ESCROW))
            .predecessor_account_id(acc(ESCROW))
            .signer_account_id(acc(ESCROW))
            .block_timestamp(NOW)
            .prepaid_gas(GAS_ON_RULING);
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(as_outlayer_delivers(&v.expected))],
        );
        let mut c: Contract = env::state_read().expect("contract state");
        c.on_ruling(0, 1);
        c.jobs.flush();
        assert_eq!(c.get_job(0).unwrap().state, JobState::Completed);
        println!(
            "host-metered gas for the heaviest sealed callback: {} of {} TGas",
            env::used_gas().as_tgas(),
            GAS_ON_RULING.as_tgas()
        );
    }
}
