use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::{Ipv4Addr, TcpListener};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::oneshot;

use crate::vault::{GatewayRequestLogInput, GatewayResolvedRoute, Vault};

const DEFAULT_GATEWAY_PORT: i64 = 8888;
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_COMPACT_URL: &str = "https://chatgpt.com/backend-api/codex/responses/compact";
const CLAUDE_ALLOWED_FORWARD_HEADERS: &[&str] = &[
    "accept",
    "x-stainless-retry-count",
    "x-stainless-timeout",
    "x-stainless-lang",
    "x-stainless-package-version",
    "x-stainless-os",
    "x-stainless-arch",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
    "x-stainless-helper-method",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-version",
    "x-app",
    "anthropic-beta",
    "accept-language",
    "sec-fetch-mode",
    "accept-encoding",
    "user-agent",
    "content-type",
    "connection",
];
const OPENAI_SKIP_FORWARD_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "authorization",
    "x-api-key",
    "x-cr-api-key",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "x-real-ip",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-accel-buffering",
    "cf-ray",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-visitor",
    "cf-request-id",
    "cdn-loop",
    "true-client-ip",
];

#[derive(Default)]
pub struct GatewayRuntime {
    port: Option<u16>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct GatewayContext {
    client: reqwest::Client,
    vault: Arc<Mutex<Vault>>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthFile {
    access_token: Option<String>,
    account_id: Option<String>,
    tokens: Option<CodexAuthTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Debug)]
struct CodexAuthContext {
    access_token: String,
    account_id: String,
}

#[derive(Serialize)]
struct OpenAIErrorBody {
    error: OpenAIErrorInfo,
}

#[derive(Serialize)]
struct OpenAIErrorInfo {
    message: String,
    r#type: String,
    code: String,
}

#[derive(Serialize)]
struct ModelList {
    object: String,
    data: Vec<ModelItem>,
}

#[derive(Serialize)]
struct ModelItem {
    id: String,
    object: String,
    created: i64,
    owned_by: String,
}

pub fn sync_gateway_runtime(state: &AppState) -> Result<(), String> {
    let (enabled, port) = {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        match vault.get_service_runtime("gateway")? {
            Some((enabled, port)) => (enabled, port.unwrap_or(DEFAULT_GATEWAY_PORT)),
            None => (true, DEFAULT_GATEWAY_PORT),
        }
    };

    let mut runtime = state.gateway.lock().map_err(|e| e.to_string())?;

    if !enabled {
        stop_gateway_locked(&mut runtime);
        return Ok(());
    }

    if !(1..=65535).contains(&port) {
        stop_gateway_locked(&mut runtime);
        return Err(format!("Invalid gateway port: {}", port));
    }

    let desired_port = port as u16;
    if runtime.task.is_some() && runtime.port == Some(desired_port) {
        return Ok(());
    }

    stop_gateway_locked(&mut runtime);

    let vault_handle = state.vault.clone();

    let std_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, desired_port))
        .map_err(|e| format!("Failed to bind gateway 127.0.0.1:{}: {}", desired_port, e))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set gateway listener non-blocking: {}", e))?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (init_tx, init_rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let task = tauri::async_runtime::spawn(async move {
        let listener = match TokioTcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(err) => {
                let _ = init_tx.send(Err(format!("Failed to create async listener: {}", err)));
                return;
            }
        };

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .user_agent("mykey-gateway/1.0")
            .build()
        {
            Ok(client) => client,
            Err(err) => {
                let _ = init_tx.send(Err(format!(
                    "Failed to initialize gateway HTTP client: {}",
                    err
                )));
                return;
            }
        };

        let context = GatewayContext {
            client,
            vault: vault_handle,
        };
        let app = Router::new()
            .route("/health", get(health))
            .route("/models", get(models))
            .route("/v1/models", get(models))
            .route("/responses", post(relay_responses))
            .route("/v1/responses", post(relay_responses))
            .route("/responses/compact", post(relay_responses_compact))
            .route("/v1/responses/compact", post(relay_responses_compact))
            .route("/messages", post(relay_claude_messages))
            .route("/v1/messages", post(relay_claude_messages))
            .route("/chat/completions", post(relay_to_codex_chat_completions))
            .route(
                "/v1/chat/completions",
                post(relay_to_codex_chat_completions),
            )
            .with_state(context);

        let _ = init_tx.send(Ok(()));
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(err) = server.await {
            eprintln!("Gateway stopped with error: {}", err);
        }
    });

    match init_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = shutdown_tx.send(());
            task.abort();
            return Err(err);
        }
        Err(_) => {
            let _ = shutdown_tx.send(());
            task.abort();
            return Err("Failed to initialize gateway runtime".to_string());
        }
    }

    runtime.port = Some(desired_port);
    runtime.shutdown = Some(shutdown_tx);
    runtime.task = Some(task);
    Ok(())
}

fn stop_gateway_locked(runtime: &mut GatewayRuntime) {
    if let Some(signal) = runtime.shutdown.take() {
        let _ = signal.send(());
    }
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    runtime.port = None;
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "gateway",
        "compat": "openai-responses",
    }))
}

async fn models() -> impl IntoResponse {
    Json(ModelList {
        object: "list".to_string(),
        data: vec![
            ModelItem {
                id: "gpt-5-codex".to_string(),
                object: "model".to_string(),
                created: 0,
                owned_by: "openai".to_string(),
            },
            ModelItem {
                id: "gpt-5".to_string(),
                object: "model".to_string(),
                created: 0,
                owned_by: "openai".to_string(),
            },
            ModelItem {
                id: "gpt-4.1".to_string(),
                object: "model".to_string(),
                created: 0,
                owned_by: "openai".to_string(),
            },
            ModelItem {
                id: "claude-sonnet-4-20250514".to_string(),
                object: "model".to_string(),
                created: 0,
                owned_by: "anthropic".to_string(),
            },
        ],
    })
}

fn extract_gateway_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = header_value(headers, "authorization") {
        let trimmed = auth.trim();
        if let Some(value) = trimmed.strip_prefix("Bearer ") {
            return Some(value.trim().to_string());
        }
        if let Some(value) = trimmed.strip_prefix("bearer ") {
            return Some(value.trim().to_string());
        }
    }
    header_value(headers, "x-api-key")
        .or_else(|| header_value(headers, "api-key"))
        .or_else(|| header_value(headers, "anthropic-api-key"))
}

fn resolve_route_from_headers(
    context: &GatewayContext,
    headers: &HeaderMap,
) -> Result<GatewayResolvedRoute, Response> {
    let token = extract_gateway_token(headers).ok_or_else(|| {
        error_response(
            StatusCode::UNAUTHORIZED,
            "Missing gateway API key. Set Authorization Bearer sk-mykey-...",
            "missing_gateway_key",
        )
    })?;
    let vault = context.vault.lock().map_err(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Gateway vault lock failed",
            "vault_lock_failed",
        )
    })?;
    vault
        .resolve_gateway_route_by_token(&token)
        .map_err(|err| {
            error_response(
                StatusCode::UNAUTHORIZED,
                &format!("Invalid gateway key: {}", err),
                "invalid_gateway_key",
            )
        })?
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Gateway key not bound to any app route",
                "invalid_gateway_key",
            )
        })
}

async fn relay_responses(
    State(ctx): State<GatewayContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let route = match resolve_route_from_headers(&ctx, &headers) {
        Ok(value) => value,
        Err(err) => return err,
    };
    if route.app_type != "codex" {
        let response = error_response(
            StatusCode::FORBIDDEN,
            "This gateway key cannot access Codex responses endpoint",
            "forbidden_gateway_key",
        );
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/responses",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some("forbidden_gateway_key"),
            Some("forbidden_gateway_key"),
        );
        return response;
    }
    if let Some(reason) = policy_block_reason(&ctx) {
        let response = policy_blocked_response(&reason);
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/responses",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some(&reason),
            Some(&reason),
        );
        return response;
    }
    let response = relay_to_codex(ctx.clone(), headers, body, false).await;
    let status = response.status();
    let code = if status.is_success() {
        None
    } else {
        Some(default_error_code_for_status(status))
    };
    append_gateway_log(
        &ctx,
        Some(&route),
        "/v1/responses",
        status,
        started.elapsed().as_millis() as i64,
        None,
        code,
    );
    response
}

async fn relay_responses_compact(
    State(ctx): State<GatewayContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let route = match resolve_route_from_headers(&ctx, &headers) {
        Ok(value) => value,
        Err(err) => return err,
    };
    if route.app_type != "codex" {
        let response = error_response(
            StatusCode::FORBIDDEN,
            "This gateway key cannot access Codex responses endpoint",
            "forbidden_gateway_key",
        );
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/responses/compact",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some("forbidden_gateway_key"),
            Some("forbidden_gateway_key"),
        );
        return response;
    }
    if let Some(reason) = policy_block_reason(&ctx) {
        let response = policy_blocked_response(&reason);
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/responses/compact",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some(&reason),
            Some(&reason),
        );
        return response;
    }
    let response = relay_to_codex(ctx.clone(), headers, body, true).await;
    let status = response.status();
    let code = if status.is_success() {
        None
    } else {
        Some(default_error_code_for_status(status))
    };
    append_gateway_log(
        &ctx,
        Some(&route),
        "/v1/responses/compact",
        status,
        started.elapsed().as_millis() as i64,
        None,
        code,
    );
    response
}

async fn relay_to_codex_chat_completions(
    State(ctx): State<GatewayContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let route = match resolve_route_from_headers(&ctx, &headers) {
        Ok(value) => value,
        Err(err) => return err,
    };
    if route.app_type != "codex" {
        let response = error_response(
            StatusCode::FORBIDDEN,
            "This gateway key cannot access Codex endpoint",
            "forbidden_gateway_key",
        );
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/chat/completions",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some("forbidden_gateway_key"),
            Some("forbidden_gateway_key"),
        );
        return response;
    }
    if let Some(reason) = policy_block_reason(&ctx) {
        let response = policy_blocked_response(&reason);
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/chat/completions",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some(&reason),
            Some(&reason),
        );
        return response;
    }
    let response = relay_to_codex(ctx.clone(), headers, body, false).await;
    let status = response.status();
    let code = if status.is_success() {
        None
    } else {
        Some(default_error_code_for_status(status))
    };
    append_gateway_log(
        &ctx,
        Some(&route),
        "/v1/chat/completions",
        status,
        started.elapsed().as_millis() as i64,
        None,
        code,
    );
    response
}

async fn relay_claude_messages(
    State(ctx): State<GatewayContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let route = match resolve_route_from_headers(&ctx, &headers) {
        Ok(value) => value,
        Err(err) => return err,
    };
    if route.app_type != "claude-code" {
        let response = error_response(
            StatusCode::FORBIDDEN,
            "This gateway key cannot access Claude endpoint",
            "forbidden_gateway_key",
        );
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/messages",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some("forbidden_gateway_key"),
            Some("forbidden_gateway_key"),
        );
        return response;
    }
    if let Some(reason) = policy_block_reason(&ctx) {
        let response = policy_blocked_response(&reason);
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/messages",
            response.status(),
            started.elapsed().as_millis() as i64,
            Some(&reason),
            Some(&reason),
        );
        return response;
    }

    let mut payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            let response = error_response(
                StatusCode::BAD_REQUEST,
                &format!("Invalid JSON body: {}", err),
                "invalid_json",
            );
            append_gateway_log(
                &ctx,
                Some(&route),
                "/v1/messages",
                response.status(),
                started.elapsed().as_millis() as i64,
                None,
                Some("invalid_json"),
            );
            return response;
        }
    };
    if let Some(model) = route.model.clone() {
        if let Some(obj) = payload.as_object_mut() {
            obj.entry("model").or_insert(Value::String(model));
        }
    }

    let upstream_base = route
        .upstream_base_url
        .clone()
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let upstream_url = if upstream_base.ends_with("/v1") {
        format!("{}/messages", upstream_base)
    } else {
        format!("{}/v1/messages", upstream_base.trim_end_matches('/'))
    };

    let is_stream = payload
        .get("stream")
        .and_then(|item| item.as_bool())
        .unwrap_or(false);

    let mut request = ctx
        .client
        .post(upstream_url)
        .header(CONTENT_TYPE, "application/json")
        .header("x-api-key", route.upstream_api_key.clone())
        .header(
            "anthropic-version",
            header_value(&headers, "anthropic-version").unwrap_or_else(|| "2023-06-01".to_string()),
        )
        .header(
            "accept",
            if is_stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .json(&payload);

    for (name, value) in build_claude_forward_headers(&headers) {
        if name.as_str().eq_ignore_ascii_case("content-length")
            || name.as_str().eq_ignore_ascii_case("authorization")
            || name.as_str().eq_ignore_ascii_case("x-api-key")
            || name.as_str().eq_ignore_ascii_case("anthropic-api-key")
        {
            continue;
        }
        request = request.header(name, value);
    }

    if let Some(beta) = header_value(&headers, "anthropic-beta") {
        request = request.header("anthropic-beta", beta);
    }

    let upstream = match request.send().await {
        Ok(value) => value,
        Err(err) => {
            let response = error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to call Claude upstream: {}", err),
                "upstream_error",
            );
            append_gateway_log(
                &ctx,
                Some(&route),
                "/v1/messages",
                response.status(),
                started.elapsed().as_millis() as i64,
                None,
                Some("upstream_error"),
            );
            return response;
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream.headers().clone();

    if status.is_client_error() || status.is_server_error() {
        let retry_after = upstream_headers.get("retry-after").cloned();
        let body = upstream.bytes().await.unwrap_or_default();
        let (parsed_message, parsed_code) = parse_error_payload(&body);
        let fallback_code = default_error_code_for_status(status);
        let response = error_response_with_retry_after(
            status,
            parsed_message
                .as_deref()
                .unwrap_or("Claude upstream request failed"),
            parsed_code.as_deref().unwrap_or(fallback_code),
            retry_after,
        );
        append_gateway_log(
            &ctx,
            Some(&route),
            "/v1/messages",
            response.status(),
            started.elapsed().as_millis() as i64,
            None,
            parsed_code.as_deref().or(Some(fallback_code)),
        );
        return response;
    }

    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;

    apply_passed_response_headers(&mut response, &upstream_headers, true);
    if !response.headers().contains_key(CONTENT_TYPE) {
        let default_type = if is_stream {
            HeaderValue::from_static("text/event-stream")
        } else {
            HeaderValue::from_static("application/json")
        };
        response.headers_mut().insert(CONTENT_TYPE, default_type);
    }

    append_gateway_log(
        &ctx,
        Some(&route),
        "/v1/messages",
        response.status(),
        started.elapsed().as_millis() as i64,
        None,
        None,
    );
    response
}

fn policy_block_reason(context: &GatewayContext) -> Option<String> {
    let vault = context.vault.lock().ok()?;
    vault.check_gateway_policy_block_reason().ok().flatten()
}

fn policy_blocked_response(reason: &str) -> Response {
    match reason {
        "global_circuit_breaker" => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Gateway is paused by global circuit breaker",
            "global_circuit_breaker",
        ),
        "daily_budget_exceeded" => error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "Gateway daily budget exceeded",
            "daily_budget_exceeded",
        ),
        _ => error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "Gateway policy blocked this request",
            "policy_blocked",
        ),
    }
}

fn append_gateway_log(
    context: &GatewayContext,
    route: Option<&GatewayResolvedRoute>,
    endpoint: &str,
    status: StatusCode,
    latency_ms: i64,
    blocked_reason: Option<&str>,
    error_code: Option<&str>,
) {
    let app_type = route
        .map(|value| value.app_type.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let provider = route
        .map(|value| value.provider.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let model = route.and_then(|value| value.model.clone());

    if let Ok(vault) = context.vault.lock() {
        let _ = vault.append_gateway_request_log(GatewayRequestLogInput {
            app_type,
            provider,
            model,
            endpoint: endpoint.to_string(),
            status_code: i64::from(status.as_u16()),
            latency_ms,
            blocked_reason: blocked_reason.map(|value| value.to_string()),
            error_code: error_code.map(|value| value.to_string()),
            estimated_cost_usd: None,
        });
    }
}

async fn relay_to_codex(
    context: GatewayContext,
    headers: HeaderMap,
    body: Bytes,
    compact: bool,
) -> Response {
    let auth = match read_codex_auth_context() {
        Ok(value) => value,
        Err(err) => {
            return error_response(StatusCode::UNAUTHORIZED, &err, "missing_codex_auth");
        }
    };

    let mut payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("Invalid JSON body: {}", err),
                "invalid_json",
            );
        }
    };
    if !payload.is_object() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Request body must be a JSON object.",
            "invalid_json",
        );
    }

    let is_stream = payload
        .get("stream")
        .and_then(|item| item.as_bool())
        .unwrap_or(true);
    if !compact {
        if let Some(root) = payload.as_object_mut() {
            root.insert("store".to_string(), Value::Bool(false));
        }
    }

    let upstream_url = if compact {
        CODEX_RESPONSES_COMPACT_URL
    } else {
        CODEX_RESPONSES_URL
    };

    let mut request = context
        .client
        .post(upstream_url)
        .bearer_auth(auth.access_token)
        .header("chatgpt-account-id", auth.account_id)
        .header(
            "accept",
            if is_stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .header(CONTENT_TYPE, "application/json")
        .json(&payload);

    for (name, value) in build_openai_forward_headers(&headers) {
        if name.as_str().eq_ignore_ascii_case("content-length")
            || name.as_str().eq_ignore_ascii_case("authorization")
            || name.as_str().eq_ignore_ascii_case("x-api-key")
        {
            continue;
        }
        request = request.header(name, value);
    }

    let upstream = match request.send().await {
        Ok(value) => value,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to call Codex upstream: {}", err),
                "upstream_error",
            );
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream.headers().clone();

    if status.is_client_error() || status.is_server_error() {
        let retry_after = upstream_headers.get("retry-after").cloned();
        let body = upstream.bytes().await.unwrap_or_default();
        let (parsed_message, parsed_code) = parse_error_payload(&body);
        let fallback_code = default_error_code_for_status(status);
        return error_response_with_retry_after(
            status,
            parsed_message
                .as_deref()
                .unwrap_or("Codex upstream request failed"),
            parsed_code.as_deref().unwrap_or(fallback_code),
            retry_after,
        );
    }

    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;

    apply_passed_response_headers(&mut response, &upstream_headers, false);
    if !response.headers().contains_key(CONTENT_TYPE) {
        let default_type = if is_stream {
            HeaderValue::from_static("text/event-stream")
        } else {
            HeaderValue::from_static("application/json")
        };
        response.headers_mut().insert(CONTENT_TYPE, default_type);
    }

    response
}

fn should_pass_header(name: &HeaderName) -> bool {
    if matches!(
        name.as_str(),
        "content-type"
            | "cache-control"
            | "retry-after"
            | "x-request-id"
            | "openai-version"
            | "openai-processing-ms"
            | "x-ratelimit-limit-requests"
            | "x-ratelimit-remaining-requests"
            | "x-ratelimit-reset-requests"
            | "x-ratelimit-limit-tokens"
            | "x-ratelimit-remaining-tokens"
            | "x-ratelimit-reset-tokens"
    ) {
        return true;
    }
    name.as_str().starts_with("x-codex-")
}

fn build_claude_forward_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let mut result = Vec::new();
    for (name, value) in headers {
        let key = name.as_str().to_ascii_lowercase();
        if CLAUDE_ALLOWED_FORWARD_HEADERS.contains(&key.as_str()) {
            result.push((name.clone(), value.clone()));
        }
    }
    result
}

fn build_openai_forward_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let mut result = Vec::new();
    for (name, value) in headers {
        let key = name.as_str().to_ascii_lowercase();
        if !OPENAI_SKIP_FORWARD_HEADERS.contains(&key.as_str()) {
            result.push((name.clone(), value.clone()));
        }
    }
    result
}

fn apply_passed_response_headers(
    target: &mut Response,
    upstream_headers: &HeaderMap,
    is_claude: bool,
) {
    for (name, value) in upstream_headers {
        if should_pass_header(name) || (is_claude && name.as_str().starts_with("anthropic-")) {
            target.headers_mut().insert(name.clone(), value.clone());
        }
    }
}

fn parse_error_payload(raw: &[u8]) -> (Option<String>, Option<String>) {
    let text = String::from_utf8_lossy(raw).trim().to_string();
    if text.is_empty() {
        return (None, None);
    }

    let parsed_direct: Result<Value, _> = serde_json::from_str(&text);
    let value = if let Ok(json) = parsed_direct {
        Some(json)
    } else {
        let mut from_sse = None;
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                continue;
            }
            let payload = trimmed.trim_start_matches("data:").trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<Value>(payload) {
                from_sse = Some(json);
                break;
            }
        }
        from_sse
    };

    if let Some(json) = value {
        let message = json
            .get("error")
            .and_then(|v| v.get("message").or_else(|| v.get("error")))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .or_else(|| {
                json.get("message")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
            });
        let code = json
            .get("error")
            .and_then(|v| v.get("code").or_else(|| v.get("type")))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .or_else(|| {
                json.get("code")
                    .or_else(|| json.get("type"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
            });
        return (message, code);
    }

    (Some(text), None)
}

fn error_response_with_retry_after(
    status: StatusCode,
    message: &str,
    code: &str,
    retry_after: Option<HeaderValue>,
) -> Response {
    let mut response = error_response(status, message, code);
    if let Some(value) = retry_after {
        response.headers_mut().insert("retry-after", value);
    }
    response
}

fn default_error_code_for_status(status: StatusCode) -> &'static str {
    match status {
        StatusCode::UNAUTHORIZED => "upstream_unauthorized",
        StatusCode::FORBIDDEN => "upstream_forbidden",
        StatusCode::TOO_MANY_REQUESTS => "upstream_rate_limited",
        StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT | StatusCode::SERVICE_UNAVAILABLE => {
            "upstream_unavailable"
        }
        _ if status.is_server_error() => "upstream_server_error",
        _ if status.is_client_error() => "upstream_client_error",
        _ => "upstream_error",
    }
}

fn header_value(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
}

fn read_codex_auth_context() -> Result<CodexAuthContext, String> {
    let env_access = std::env::var("MYKEY_CODEX_ACCESS_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let env_account = std::env::var("MYKEY_CODEX_ACCOUNT_ID")
        .ok()
        .or_else(|| std::env::var("CHATGPT_ACCOUNT_ID").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut file_access = None;
    let mut file_account = None;
    if let Some(path) = codex_auth_path() {
        if path.exists() {
            let raw = std::fs::read_to_string(&path).map_err(|e| {
                format!(
                    "Failed to read Codex auth file ({}): {}",
                    path.to_string_lossy(),
                    e
                )
            })?;
            let parsed: CodexAuthFile = serde_json::from_str(&raw).map_err(|e| {
                format!(
                    "Invalid Codex auth JSON ({}): {}",
                    path.to_string_lossy(),
                    e
                )
            })?;
            if let Some(tokens) = parsed.tokens {
                file_access = tokens
                    .access_token
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                file_account = tokens
                    .account_id
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
            }
            if file_access.is_none() {
                file_access = parsed
                    .access_token
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
            }
            if file_account.is_none() {
                file_account = parsed
                    .account_id
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
            }
        }
    }

    let access_token = env_access.or(file_access).ok_or_else(|| {
        "Codex access token not found. Login Codex CLI first or set MYKEY_CODEX_ACCESS_TOKEN."
            .to_string()
    })?;
    let account_id = env_account.or(file_account).ok_or_else(|| {
        "Codex account_id not found. Login Codex CLI first or set MYKEY_CODEX_ACCOUNT_ID."
            .to_string()
    })?;

    Ok(CodexAuthContext {
        access_token,
        account_id,
    })
}

fn codex_auth_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex").join("auth.json"))
}

fn error_response(status: StatusCode, message: &str, code: &str) -> Response {
    (
        status,
        Json(OpenAIErrorBody {
            error: OpenAIErrorInfo {
                message: message.to_string(),
                r#type: "gateway_error".to_string(),
                code: code.to_string(),
            },
        }),
    )
        .into_response()
}
