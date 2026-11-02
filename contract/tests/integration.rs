//! Integration tests: escrow + a mock OutLayer on a near-workspaces sandbox.
//!
//! These exercise the real cross-contract path: request_ruling calls the mock's request_execution,
//! the mock returns configured RAW bytes, and the escrow's on_ruling callback acts on them. The mock
//! returns its value directly (no yield), which is invisible to on_ruling since it only reads
//! promise_result(0).
//!
//! near-workspaces downloads a NEAR sandbox binary on first run (it did here on Nov 1 2026). The
//! wasm for both contracts is built on the fly with compile_project (near-workspaces "unstable"),
//! once per test process.
//!
//! Sealed-job tests use the judge's real vectors (judge-wasm/vectors/sealed.json), so the escrow is
//! checked against the exact verdict bytes the judge produces.

use near_workspaces::types::{Gas, NearToken};
use serde_json::json;
use tokio::sync::OnceCell;

static ESCROW_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static MOCK_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn escrow_wasm() -> &'static [u8] {
    ESCROW_WASM
        .get_or_init(|| async { near_workspaces::compile_project(".").await.expect("escrow builds") })
        .await
}

async fn mock_wasm() -> &'static [u8] {
    MOCK_WASM
        .get_or_init(|| async {
            near_workspaces::compile_project("./mock-outlayer").await.expect("mock builds")
        })
        .await
}

const JUDGE_URL: &str = "https://example.com/judge.wasm";
const BUILD_TARGET: &str = "wasm32-wasip1";
const CRITERIA: &str = "{\"checks\":[{\"kind\":\"length\"}],\"passThreshold\":100}";
const DELIVERABLE: &str = "the quick brown fox jumps over the lazy dog";
/// 0.01 NEAR in yoctoNEAR, the minimum ruling deposit used in tests and docs.
const MIN_RULING: &str = "10000000000000000000000";
/// Mirrors the contract's GRACE_NS (one hour).
const GRACE_NS: u64 = 3_600_000_000_000;

type Sandbox = near_workspaces::Worker<near_workspaces::network::Sandbox>;

fn jhash() -> String {
    "a".repeat(64)
}

fn verdict(pass: bool, ch: &str, dh: &str) -> String {
    format!(
        "{{\"v\":1,\"pass\":{pass},\"score\":{},\"th\":100,\"ch\":\"{ch}\",\"dh\":\"{dh}\",\"checks\":[],\"eh\":\"{}\"}}",
        if pass { 100 } else { 30 },
        "e".repeat(64)
    )
}

/// Deploy escrow + mock, initialise both (escrow points at the mock as its OutLayer), and create
/// three funded accounts. Returns (worker, escrow, mock, client, provider, ranger).
async fn setup() -> anyhow::Result<(
    Sandbox,
    near_workspaces::Contract,
    near_workspaces::Contract,
    near_workspaces::Account,
    near_workspaces::Account,
    near_workspaces::Account,
)> {
    let worker = near_workspaces::sandbox().await?;
    let escrow = worker.dev_deploy(escrow_wasm().await).await?;
    let mock = worker.dev_deploy(mock_wasm().await).await?;

    mock.call("new")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    escrow
        .call("new")
        .args_json(json!({
            "outlayer": mock.id(),
            "judge_url": JUDGE_URL,
            "judge_hash": jhash(),
            "build_target": BUILD_TARGET,
            "min_ruling_deposit": MIN_RULING,
        }))
        .transact()
        .await?
        .into_result()?;

    let client = worker.dev_create_account().await?;
    let provider = worker.dev_create_account().await?;
    let ranger = worker.dev_create_account().await?;
    Ok((worker, escrow, mock, client, provider, ranger))
}

async fn create_and_fund(
    escrow: &near_workspaces::Contract,
    client: &near_workspaces::Account,
    provider: &near_workspaces::Account,
    expires_at_ns: u64,
    escrow_amount: NearToken,
) -> anyhow::Result<()> {
    client
        .call(escrow.id(), "create_job")
        .args_json(json!({
            "provider": provider.id(),
            "criteria": CRITERIA,
            "expires_at_ns": expires_at_ns.to_string(),
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    client
        .call(escrow.id(), "fund")
        .args_json(json!({ "job_id": 0 }))
        .deposit(escrow_amount)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn submit_deliverable(
    escrow: &near_workspaces::Contract,
    provider: &near_workspaces::Account,
) -> anyhow::Result<()> {
    provider
        .call(escrow.id(), "submit")
        .args_json(json!({ "job_id": 0, "deliverable": DELIVERABLE }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn job_state(escrow: &near_workspaces::Contract) -> anyhow::Result<serde_json::Value> {
    Ok(escrow
        .view("get_job")
        .args_json(json!({ "job_id": 0 }))
        .await?
        .json::<serde_json::Value>()?)
}

async fn far_future(worker: &Sandbox) -> anyhow::Result<u64> {
    let ts = worker.view_block().await?.timestamp();
    Ok(ts + GRACE_NS) // one hour ahead
}

async fn set_verdict(
    escrow: &near_workspaces::Contract,
    mock: &near_workspaces::Contract,
    pass: bool,
) -> anyhow::Result<()> {
    let job = job_state(escrow).await?;
    let (ch, dh) = (
        job["ch"].as_str().unwrap().to_string(),
        job["dh"].as_str().unwrap().to_string(),
    );
    mock.call("set_response_str")
        .args_json(json!({ "s": verdict(pass, &ch, &dh) }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn request_ruling_as(
    caller: &near_workspaces::Account,
    escrow: &near_workspaces::Contract,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller
        .call(escrow.id(), "request_ruling")
        .args_json(json!({ "job_id": 0 }))
        .deposit(NearToken::from_millinear(50))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

#[tokio::test]
async fn pass_flow_pays_provider() -> anyhow::Result<()> {
    let (worker, escrow, mock, client, provider, _ranger) = setup().await?;
    let expires = far_future(&worker).await?;
    create_and_fund(&escrow, &client, &provider, expires, NearToken::from_near(5)).await?;
    submit_deliverable(&escrow, &provider).await?;
    set_verdict(&escrow, &mock, true).await?;

    // The provider asks for the ruling (it wants to be paid).
    let before = provider.view_account().await?.balance;
    request_ruling_as(&provider, &escrow).await?.into_result()?;
    let after = provider.view_account().await?.balance;

    assert_eq!(job_state(&escrow).await?["state"], "Completed");
    let delta = after.as_yoctonear().saturating_sub(before.as_yoctonear());
    assert!(
        delta >= NearToken::from_near(4).as_yoctonear(),
        "provider should net about the 5 NEAR escrow (minus its ruling deposit and gas), got {delta} yocto"
    );
    Ok(())
}

#[tokio::test]
async fn fail_flow_refunds_client() -> anyhow::Result<()> {
    let (worker, escrow, mock, client, provider, _ranger) = setup().await?;
    let expires = far_future(&worker).await?;
    create_and_fund(&escrow, &client, &provider, expires, NearToken::from_near(5)).await?;
    submit_deliverable(&escrow, &provider).await?;
    set_verdict(&escrow, &mock, false).await?;

    // The client asks for the ruling (it expects a refund on a failing delivery).
    let before = client.view_account().await?.balance;
    request_ruling_as(&client, &escrow).await?.into_result()?;
    let after = client.view_account().await?.balance;

    assert_eq!(job_state(&escrow).await?["state"], "Refunded");
    assert!(
        after.as_yoctonear() > before.as_yoctonear(),
        "client should have been refunded"
    );
    Ok(())
}

#[tokio::test]
async fn null_result_returns_to_submitted() -> anyhow::Result<()> {
    let (worker, escrow, _mock, client, provider, _ranger) = setup().await?;
    let expires = far_future(&worker).await?;
    create_and_fund(&escrow, &client, &provider, expires, NearToken::from_near(5)).await?;
    submit_deliverable(&escrow, &provider).await?;

    // The mock defaults to returning the bytes `null` (OutLayer's failure result).
    request_ruling_as(&provider, &escrow).await?.into_result()?;

    assert_eq!(job_state(&escrow).await?["state"], "Submitted");
    Ok(())
}

#[tokio::test]
async fn expiry_refunds_funded_job() -> anyhow::Result<()> {
    // Nothing delivered: a Funded job is refundable at plain expiry.
    let (worker, escrow, _mock, client, provider, ranger) = setup().await?;
    let ts = worker.view_block().await?.timestamp();
    let expires = ts + 1_500_000_000; // about 1.5 s ahead
    create_and_fund(&escrow, &client, &provider, expires, NearToken::from_near(5)).await?;

    worker.fast_forward(200).await?;
    assert!(worker.view_block().await?.timestamp() >= expires, "not yet past expiry");

    let before = client.view_account().await?.balance;
    ranger
        .call(escrow.id(), "claim_refund")
        .args_json(json!({ "job_id": 0 }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?
        .into_result()?;
    let after = client.view_account().await?.balance;

    assert_eq!(job_state(&escrow).await?["state"], "Refunded");
    assert!(
        after.as_yoctonear() > before.as_yoctonear(),
        "client should have been refunded after expiry"
    );
    Ok(())
}

#[tokio::test]
async fn submitted_job_not_refundable_at_plain_expiry() -> anyhow::Result<()> {
    // Delivered work gets a ruling window: past expires_at but inside the grace period, a
    // Submitted job cannot be refunded (this is the griefing fix, end to end).
    let (worker, escrow, _mock, client, provider, ranger) = setup().await?;
    let ts = worker.view_block().await?.timestamp();
    let expires = ts + 1_500_000_000; // about 1.5 s ahead
    create_and_fund(&escrow, &client, &provider, expires, NearToken::from_near(5)).await?;
    submit_deliverable(&escrow, &provider).await?;

    worker.fast_forward(200).await?;
    let now = worker.view_block().await?.timestamp();
    // Self-check so the test cannot pass vacuously: we must be past expiry and well inside grace.
    assert!(now >= expires, "not yet past expiry, test would be vacuous");
    assert!(
        now + 60_000_000_000 < expires + GRACE_NS,
        "fast_forward went past the grace window, test would not exercise it"
    );

    let outcome = ranger
        .call(escrow.id(), "claim_refund")
        .args_json(json!({ "job_id": 0 }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let err = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(err.contains("not refundable"), "expected a not-refundable rejection, got: {err}");
    assert_eq!(job_state(&escrow).await?["state"], "Submitted");
    Ok(())
}

#[tokio::test]
async fn third_party_cannot_request_ruling() -> anyhow::Result<()> {
    let (worker, escrow, _mock, client, provider, ranger) = setup().await?;
    let expires = far_future(&worker).await?;
    create_and_fund(&escrow, &client, &provider, expires, NearToken::from_near(5)).await?;
    submit_deliverable(&escrow, &provider).await?;

    let outcome = request_ruling_as(&ranger, &escrow).await?;
    let err = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(
        err.contains("client or provider"),
        "a third party must be rejected, got: {err}"
    );
    assert_eq!(job_state(&escrow).await?["state"], "Submitted");
    Ok(())
}

#[tokio::test]
async fn on_ruling_is_private() -> anyhow::Result<()> {
    // An external account cannot call the settlement callback directly.
    let (_worker, escrow, _mock, _client, _provider, ranger) = setup().await?;
    let outcome = ranger
        .call(escrow.id(), "on_ruling")
        .args_json(json!({ "job_id": 0, "attempt": 1 }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    // Must be rejected specifically by the #[private] guard, not merely fail for some other reason
    // (for example a missing promise result). The error text names the private method.
    let err = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(
        err.contains("private"),
        "on_ruling must be rejected as a private method, got: {err}"
    );
    Ok(())
}

// ---- sealed jobs (interface.md section 6) ----

const SEALED_VECTORS: &str = include_str!("../../judge-wasm/vectors/sealed.json");

struct Vector {
    criteria: String,
    deliverable_ct: String,
    dh: String,
    client_pk: String,
    expected: String,
}

fn vector(i: usize) -> Vector {
    let all: serde_json::Value = serde_json::from_str(SEALED_VECTORS).unwrap();
    let stdin: serde_json::Value = serde_json::from_str(all[i]["stdin"].as_str().unwrap()).unwrap();
    Vector {
        criteria: stdin["criteria"].as_str().unwrap().to_string(),
        deliverable_ct: stdin["deliverable_ct"].as_str().unwrap().to_string(),
        dh: stdin["dh"].as_str().unwrap().to_string(),
        client_pk: stdin["client_pk"].as_str().unwrap().to_string(),
        expected: all[i]["expected"].as_str().unwrap().to_string(),
    }
}

type JsonMap = std::collections::BTreeMap<String, serde_json::Value>;

/// A verdict as OutLayer delivers it (keys sorted, interface.md 6.5), optionally with k replaced.
fn delivered(verdict: &str, k: Option<&str>) -> String {
    let mut m: JsonMap = serde_json::from_str(verdict).unwrap();
    if let Some(k) = k {
        m.insert("k".to_string(), serde_json::Value::String(k.to_string()));
    }
    serde_json::to_string(&m).unwrap()
}

async fn create_sealed_and_fund(
    escrow: &near_workspaces::Contract,
    client: &near_workspaces::Account,
    provider: &near_workspaces::Account,
    expires_at_ns: u64,
    v: &Vector,
) -> anyhow::Result<()> {
    client
        .call(escrow.id(), "create_job")
        .args_json(json!({
            "provider": provider.id(),
            "criteria": v.criteria,
            "expires_at_ns": expires_at_ns.to_string(),
            "client_pk": v.client_pk,
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    client
        .call(escrow.id(), "fund")
        .args_json(json!({ "job_id": 0 }))
        .deposit(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn submit_sealed(
    escrow: &near_workspaces::Contract,
    provider: &near_workspaces::Account,
    v: &Vector,
) -> anyhow::Result<()> {
    provider
        .call(escrow.id(), "submit_sealed")
        .args_json(json!({ "job_id": 0, "deliverable_ct": v.deliverable_ct, "dh": v.dh }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Create, fund and submit a sealed job from vector `v`, load `response` into the mock, and have the
/// provider request the ruling.
async fn sealed_ruling(
    v: &Vector,
    response: &str,
) -> anyhow::Result<(
    near_workspaces::Contract,
    near_workspaces::Contract,
    near_workspaces::Account,
    near_workspaces::Account,
    NearToken,
    NearToken,
)> {
    let (worker, escrow, mock, client, provider, _ranger) = setup().await?;
    let expires = far_future(&worker).await?;
    create_sealed_and_fund(&escrow, &client, &provider, expires, v).await?;
    submit_sealed(&escrow, &provider, v).await?;
    mock.call("set_response_str")
        .args_json(json!({ "s": response }))
        .transact()
        .await?
        .into_result()?;
    let client_before = client.view_account().await?.balance;
    let provider_before = provider.view_account().await?.balance;
    request_ruling_as(&provider, &escrow).await?.into_result()?;
    Ok((escrow, mock, client, provider, client_before, provider_before))
}

#[tokio::test]
async fn sealed_pass_pays_provider_and_stores_k() -> anyhow::Result<()> {
    let v = vector(0);
    let k = serde_json::from_str::<serde_json::Value>(&v.expected)?["k"]
        .as_str()
        .unwrap()
        .to_string();
    let (escrow, _mock, _client, provider, _cb, provider_before) =
        sealed_ruling(&v, &delivered(&v.expected, None)).await?;

    let job = job_state(&escrow).await?;
    assert_eq!(job["state"], "Completed");
    assert_eq!(job["sealed"], true);
    assert_eq!(job["k"], k.as_str());
    let delta = provider
        .view_account()
        .await?
        .balance
        .as_yoctonear()
        .saturating_sub(provider_before.as_yoctonear());
    assert!(
        delta >= NearToken::from_near(4).as_yoctonear(),
        "provider should net about the 5 NEAR escrow, got {delta} yocto"
    );
    Ok(())
}

#[tokio::test]
async fn sealed_key_missing_returns_to_submitted() -> anyhow::Result<()> {
    let v = vector(15);
    let (escrow, _mock, _client, _provider, _cb, _pb) =
        sealed_ruling(&v, &delivered(&v.expected, None)).await?;
    let job = job_state(&escrow).await?;
    assert_eq!(job["state"], "Submitted");
    assert!(job["k"].is_null());
    Ok(())
}

#[tokio::test]
async fn sealed_bad_delivery_refunds_client() -> anyhow::Result<()> {
    let v = vector(20);
    let (escrow, _mock, client, _provider, client_before, _pb) =
        sealed_ruling(&v, &delivered(&v.expected, None)).await?;
    assert_eq!(job_state(&escrow).await?["state"], "Refunded");
    assert!(
        client.view_account().await?.balance.as_yoctonear() > client_before.as_yoctonear(),
        "client should have been refunded"
    );
    Ok(())
}

#[tokio::test]
async fn sealed_malformed_k_returns_to_submitted() -> anyhow::Result<()> {
    let v = vector(0);
    let truncated = {
        let k = serde_json::from_str::<serde_json::Value>(&v.expected)?["k"]
            .as_str()
            .unwrap()
            .to_string();
        k[..123].to_string()
    };
    let (escrow, _mock, _client, _provider, _cb, _pb) =
        sealed_ruling(&v, &delivered(&v.expected, Some(&truncated))).await?;
    let job = job_state(&escrow).await?;
    assert_eq!(job["state"], "Submitted");
    assert!(job["k"].is_null());
    Ok(())
}

#[tokio::test]
async fn sealed_request_carries_secrets_ref_and_sealed_input() -> anyhow::Result<()> {
    let v = vector(0);
    let (escrow, mock, _client, provider, _cb, _pb) =
        sealed_ruling(&v, &delivered(&v.expected, None)).await?;

    let profile: Option<String> = escrow
        .view("get_secrets_profile")
        .args_json(json!({ "job_id": 0 }))
        .await?
        .json()?;
    let profile = profile.expect("a sealed job has a secrets profile");
    assert!(profile.starts_with("jn-") && profile.ends_with("-0") && profile.len() == 21);

    let recorded: Option<String> = mock.view("get_last_secrets_ref").await?.json()?;
    let secrets_ref: serde_json::Value = serde_json::from_str(&recorded.expect("secrets_ref sent"))?;
    assert_eq!(
        secrets_ref,
        json!({ "profile": profile, "account_id": provider.id() })
    );

    let input: Option<String> = mock.view("get_last_input_data").await?.json()?;
    let input: serde_json::Value = serde_json::from_str(&input.expect("input_data sent"))?;
    let mut keys: Vec<&str> = input.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(keys, ["client_pk", "criteria", "deliverable_ct", "dh"]);
    assert_eq!(input["criteria"], v.criteria.as_str());
    assert_eq!(input["deliverable_ct"], v.deliverable_ct.as_str());
    assert_eq!(input["dh"], v.dh.as_str());
    assert_eq!(input["client_pk"], v.client_pk.as_str());
    Ok(())
}

#[tokio::test]
async fn small_order_client_pk_refused() -> anyhow::Result<()> {
    let (worker, escrow, _mock, client, provider, _ranger) = setup().await?;
    let expires = far_future(&worker).await?;
    // libsodium blocklist entry: p - 1 (order 2).
    let small = format!("ec{}7f", "ff".repeat(30));
    let outcome = client
        .call(escrow.id(), "create_job")
        .args_json(json!({
            "provider": provider.id(),
            "criteria": CRITERIA,
            "expires_at_ns": expires.to_string(),
            "client_pk": small,
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    let err = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(err.contains("small-order"), "expected a small-order refusal, got: {err}");
    Ok(())
}
