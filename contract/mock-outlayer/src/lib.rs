//! Mock OutLayer for integration tests.
//!
//! A tiny contract whose request_execution returns configurable RAW bytes (set beforehand by the
//! test) via env::value_return, so the escrow's .then(on_ruling) callback reads them exactly as it
//! would read a real OutLayer result. Returning the value directly is enough for the callback; the
//! real OutLayer parks a yield promise, but that difference is invisible to our callback, which only
//! reads promise_result(0).
//!
//! The mock also records the last call's input_data and payer so a test can assert the escrow sent
//! the shape we expect, and it can be told to panic to exercise the escrow's PromiseResult::Failed
//! branch.

use near_sdk::{AccountId, PanicOnDefault, env, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    /// Raw bytes returned from request_execution. Defaults to the literal `null` (OutLayer's failure
    /// result).
    response: Vec<u8>,
    /// When true, request_execution panics, simulating a contract-level failure.
    should_panic: bool,
    last_input_data: Option<String>,
    last_payer: Option<AccountId>,
    last_deposit: near_sdk::json_types::U128,
    call_count: u64,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self {
            response: b"null".to_vec(),
            should_panic: false,
            last_input_data: None,
            last_payer: None,
            last_deposit: near_sdk::json_types::U128(0),
            call_count: 0,
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
        let _ = (source, resource_limits, secrets_ref, response_format, params);
        self.call_count += 1;
        self.last_input_data = input_data;
        self.last_payer = payer_account_id;
        self.last_deposit = near_sdk::json_types::U128(env::attached_deposit().as_yoctonear());
        if self.should_panic {
            env::panic_str("mock outlayer: forced failure");
        }
        env::value_return(&self.response);
    }

    pub fn get_last_input_data(&self) -> Option<String> {
        self.last_input_data.clone()
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
