//! Mock OutLayer for integration tests.
//!
//! A tiny contract whose request_execution returns configurable RAW bytes (set beforehand by the
//! test) via env::value_return, so the escrow's .then(on_ruling) callback reads them exactly as it
//! would read a real OutLayer result. Returning the value directly is enough for the callback; the
//! real OutLayer parks a yield promise, but that difference is invisible to our callback, which only
//! reads promise_result(0).
//!
//! The mock also records the last call's input_data, secrets_ref and payer so a test can assert the
//! escrow sent the shape we expect, and it can be told to panic to exercise the escrow's
//! PromiseResult::Failed branch.
//!
//! In hold mode it behaves like the real OutLayer: request_execution parks a yield promise and the
//! escrow's callback waits, across blocks, until the test calls resolve() (or the yield times out
//! after 200 blocks). That keeps a job in Ruling while other calls land, which a test of the refund
//! rules needs.

use near_sdk::{AccountId, Gas, GasWeight, PanicOnDefault, env, near};

/// Register the yield's data id is written to.
const YIELD_REGISTER: u64 = 0;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    /// Raw bytes returned from request_execution. Defaults to the literal `null` (OutLayer's failure
    /// result).
    response: Vec<u8>,
    /// When true, request_execution panics, simulating a contract-level failure.
    should_panic: bool,
    last_input_data: Option<String>,
    /// The last secrets_ref as compact JSON text (None when the escrow sent null).
    last_secrets_ref: Option<String>,
    last_payer: Option<AccountId>,
    last_deposit: near_sdk::json_types::U128,
    call_count: u64,
    /// When true, request_execution parks a yield promise instead of answering at once.
    hold: bool,
    /// The data id of the parked yield, until resolve() resumes it.
    held: Option<Vec<u8>>,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self {
            response: b"null".to_vec(),
            should_panic: false,
            last_input_data: None,
            last_secrets_ref: None,
            last_payer: None,
            last_deposit: near_sdk::json_types::U128(0),
            call_count: 0,
            hold: false,
            held: None,
        }
    }

    /// Hold the next rulings open (a parked yield) until resolve() is called.
    pub fn set_hold(&mut self, value: bool) {
        self.hold = value;
    }

    /// Resume the parked yield with the configured response bytes.
    pub fn resolve(&mut self) {
        let id = self.held.take().expect("mock outlayer: nothing is held");
        let id: [u8; 32] = id.try_into().expect("mock outlayer: a data id is 32 bytes");
        assert!(env::promise_yield_resume(&id, &self.response), "mock outlayer: the yield is gone");
    }

    /// The parked yield's callback: returns what resolve() passed, or null after a timeout.
    #[private]
    pub fn on_resolved(&mut self) {
        match env::promise_result_checked(0, 4096) {
            Ok(bytes) => env::value_return(&bytes),
            Err(_) => env::value_return(b"null"),
        }
    }

    /// Set the exact bytes to return (lets a test produce null, garbage, or oversized output).
    pub fn set_response_bytes(&mut self, bytes: near_sdk::json_types::Base64VecU8) {
        self.response = bytes.into();
        self.should_panic = false;
    }

    /// Convenience: set the response from a string (for a JSON verdict).
    pub fn set_response_str(&mut self, s: String) {
        self.response = s.into_bytes();
        self.should_panic = false;
    }

    pub fn set_should_panic(&mut self, value: bool) {
        self.should_panic = value;
    }

    /// Same argument order as the real OutLayer. Flexible JSON types so any shape the escrow sends is
    /// accepted. Records the call, then returns the configured bytes (or panics).
    #[payable]
    pub fn request_execution(
        &mut self,
        source: near_sdk::serde_json::Value,
        resource_limits: Option<near_sdk::serde_json::Value>,
        input_data: Option<String>,
        secrets_ref: Option<near_sdk::serde_json::Value>,
        response_format: Option<near_sdk::serde_json::Value>,
        payer_account_id: Option<AccountId>,
        params: Option<near_sdk::serde_json::Value>,
    ) {
        let _ = (source, resource_limits, response_format, params);
        self.call_count += 1;
        self.last_input_data = input_data;
        self.last_secrets_ref = secrets_ref.map(|v| v.to_string());
        self.last_payer = payer_account_id;
        self.last_deposit = near_sdk::json_types::U128(env::attached_deposit().as_yoctonear());
        if self.should_panic {
            env::panic_str("mock outlayer: forced failure");
        }
        if self.hold {
            let index = env::promise_yield_create("on_resolved", [], Gas::from_tgas(10), GasWeight(0), YIELD_REGISTER);
            self.held = Some(env::read_register(YIELD_REGISTER).expect("mock outlayer: no data id"));
            env::promise_return(index);
            return;
        }
        env::value_return(&self.response);
    }

    pub fn get_last_input_data(&self) -> Option<String> {
        self.last_input_data.clone()
    }

    pub fn get_last_secrets_ref(&self) -> Option<String> {
        self.last_secrets_ref.clone()
    }

    pub fn get_last_payer(&self) -> Option<AccountId> {
        self.last_payer.clone()
    }

    pub fn get_last_deposit(&self) -> near_sdk::json_types::U128 {
        self.last_deposit
    }

    pub fn get_call_count(&self) -> u64 {
        self.call_count
    }
}
