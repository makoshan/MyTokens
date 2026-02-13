use crate::AppState;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashSet;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::{Ipv4Addr, TcpListener};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::oneshot;

use crate::vault::{GatewayRequestLogInput, GatewayResolvedRoute, Vault};

const DEFAULT_GATEWAY_PORT: i64 = 8888;
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_COMPACT_URL: &str = "https://chatgpt.com/backend-api/codex/responses/compact";
const CODEX_DEFAULT_INSTRUCTIONS: &str =
    "You are Codex, based on GPT-5. You are a coding assistant.";
const CODEX_STRIP_FIELDS: &[&str] = &[
    "temperature",
    "top_p",
    "user",
    "text_formatting",
    "truncation",
    "text",
    "service_tier",
    "prompt_cache_retention",
    "safety_identifier",
];
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

fn model_created_at() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs() as i64)
}

fn add_model_item(
    items: &mut Vec<ModelItem>,
    seen: &mut HashSet<String>,
    provider: &str,
    model_id: &str,
    created: i64,
) {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return;
    }
    let key = format!("{provider}:{model_id}");
    if !seen.insert(key) {
        return;
    }
    items.push(ModelItem {
        id: model_id.to_string(),
        object: "model".to_string(),
        created,
        owned_by: provider.to_string(),
    });
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

async fn models(
    State(context): State<GatewayContext>,
    headers: HeaderMap,
) -> Response {
    let route = match resolve_route_from_headers(&context, &headers) {
        Ok(route) => route,
        Err(response) => return response,
    };

    let vault = match context.vault.lock() {
        Ok(vault) => vault,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Gateway route resolution failed",
                "route_resolution_failed",
            );
        }
    };
    let provider = match vault.get_provider_config(&route.provider) {
        Some(provider) => provider,
        None => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Provider config not found: {}", route.provider),
                "provider_not_found",
            );
        }
    };

    let created = model_created_at();
    let mut models = Vec::new();
    let mut seen = HashSet::new();

    if let Some(model) = route.model.as_deref() {
        add_model_item(&mut models, &mut seen, &route.provider, model, created);
    }

    for model in provider.models.iter() {
        add_model_item(&mut models, &mut seen, &route.provider, model, created);
    }

    let details = provider.details;
    add_model_item(
        &mut models,
        &mut seen,
        &route.provider,
        &details.main_model,
        created,
    );
    add_model_item(
        &mut models,
        &mut seen,
        &route.provider,
        &details.reasoning_model,
        created,
    );
    add_model_item(
        &mut models,
        &mut seen,
        &route.provider,
        &details.default_haiku_model,
        created,
    );
    add_model_item(
        &mut models,
        &mut seen,
        &route.provider,
        &details.default_sonnet_model,
        created,
    );
    add_model_item(
        &mut models,
        &mut seen,
        &route.provider,
        &details.default_opus_model,
        created,
    );

    models.sort_by(|a, b| a.id.cmp(&b.id));
    Json(ModelList {
        object: "list".to_string(),
        data: models,
    })
    .into_response()
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

fn parse_route_headers(raw: Option<&str>) -> Vec<(HeaderName, HeaderValue)> {
    let mut items = Vec::new();
    let Some(input) = raw else {
        return items;
    };
    for part in input
        .split('\n')
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some((key, value)) = part.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(value) else {
            continue;
        };
        items.push((name, header_value));
    }
    items
}

fn build_upstream_client(
    context: &GatewayContext,
    route: &GatewayResolvedRoute,
) -> Result<reqwest::Client, String> {
    let timeout_ms = route.upstream_timeout_ms.filter(|value| *value > 0);
    let proxy_url = route
        .upstream_proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if timeout_ms.is_none() && proxy_url.is_none() {
        return Ok(context.client.clone());
    }

    let mut builder = reqwest::Client::builder().user_agent("mykey-gateway/1.0");
    let timeout = timeout_ms.unwrap_or(600_000).clamp(1_000, 600_000) as u64;
    builder = builder.timeout(Duration::from_millis(timeout));

    if let Some(url) = proxy_url {
        let mut proxy = reqwest::Proxy::all(url)
            .map_err(|err| format!("Invalid proxy URL '{}': {}", url, err))?;
        if let Some(username) = route
            .upstream_proxy_username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let password = route
                .upstream_proxy_password
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            proxy = proxy.basic_auth(username, password);
        }
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|err| format!("Failed to build upstream client: {}", err))
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
    let response = relay_to_codex(ctx.clone(), headers, body, false, route.model.as_deref()).await;
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
    let response = relay_to_codex(ctx.clone(), headers, body, true, route.model.as_deref()).await;
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
    let response = relay_to_codex(ctx.clone(), headers, body, false, route.model.as_deref()).await;
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

    let client = match build_upstream_client(&ctx, &route) {
        Ok(value) => value,
        Err(err) => {
            let response = error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to prepare Claude upstream client: {}", err),
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
    let route_headers = parse_route_headers(route.upstream_headers.as_deref());
    let max_retries = route.upstream_max_retries.max(0).min(5) as usize;
    let mut last_error: Option<String> = None;
    let upstream = {
        let mut upstream = None;
        for attempt in 0..=max_retries {
            let mut request = client
                .post(&upstream_url)
                .header(CONTENT_TYPE, "application/json")
                .header("x-api-key", route.upstream_api_key.clone())
                .header(
                    "anthropic-version",
                    header_value(&headers, "anthropic-version")
                        .unwrap_or_else(|| "2023-06-01".to_string()),
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

            for (name, value) in &route_headers {
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

            match request.send().await {
                Ok(response) => {
                    let status = StatusCode::from_u16(response.status().as_u16())
                        .unwrap_or(StatusCode::BAD_GATEWAY);
                    let should_retry = attempt < max_retries
                        && matches!(
                            status,
                            StatusCode::TOO_MANY_REQUESTS
                                | StatusCode::BAD_GATEWAY
                                | StatusCode::SERVICE_UNAVAILABLE
                                | StatusCode::GATEWAY_TIMEOUT
                        );
                    if should_retry {
                        tokio::time::sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    upstream = Some(response);
                    break;
                }
                Err(err) => {
                    last_error = Some(err.to_string());
                    if attempt < max_retries {
                        tokio::time::sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                        continue;
                    }
                }
            }
        }
        match upstream {
            Some(value) => value,
            None => {
                let message = last_error.unwrap_or_else(|| "unknown error".to_string());
                let response = error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("Failed to call Claude upstream: {}", message),
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
    route_model: Option<&str>,
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

    let client_stream = payload
        .get("stream")
        .and_then(|item| item.as_bool())
        .unwrap_or(true);
    let mut upstream_stream = true;

    if let Some(root) = payload.as_object_mut() {
        normalize_codex_chat_completions_payload(root);
        for field in CODEX_STRIP_FIELDS {
            root.remove(*field);
        }

        if let Some(model) = route_model.map(str::trim).filter(|value| !value.is_empty()) {
            root.entry("model")
                .or_insert(Value::String(model.to_string()));
        }

        if root
            .get("instructions")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            let fallback = root
                .get("input")
                .and_then(extract_system_instruction_from_input)
                .unwrap_or_else(|| CODEX_DEFAULT_INSTRUCTIONS.to_string());
            root.insert("instructions".to_string(), Value::String(fallback));
        }

        if compact {
            upstream_stream = false;
            root.remove("store");
            root.remove("stream");
        } else {
            root.insert("store".to_string(), Value::Bool(false));
            root.insert("stream".to_string(), Value::Bool(true));
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
            if upstream_stream {
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
            || name.as_str().eq_ignore_ascii_case("content-type")
            || name.as_str().eq_ignore_ascii_case("accept")
            || name.as_str().eq_ignore_ascii_case("chatgpt-account-id")
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

    if !compact && !client_stream {
        let body = upstream.bytes().await.unwrap_or_default();
        let response_json = parse_codex_non_stream_response(
            &body,
            payload
                .get("model")
                .and_then(|value| value.as_str())
                .or(route_model),
        );
        let mut response = Response::new(Body::from(response_json.to_string()));
        *response.status_mut() = status;
        apply_passed_response_headers(&mut response, &upstream_headers, false);
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        return response;
    }

    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;

    apply_passed_response_headers(&mut response, &upstream_headers, false);
    if !response.headers().contains_key(CONTENT_TYPE) {
        let default_type = if upstream_stream {
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

fn normalize_codex_chat_completions_payload(root: &mut serde_json::Map<String, Value>) {
    if root.contains_key("max_output_tokens") {
        root.remove("max_tokens");
    } else if let Some(value) = root.remove("max_tokens") {
        root.insert("max_output_tokens".to_string(), value);
    }

    if root.contains_key("input") {
        return;
    }

    let Some(messages_value) = root.remove("messages") else {
        return;
    };
    let Some(messages) = messages_value.as_array() else {
        return;
    };

    let mut instructions_parts: Vec<String> = Vec::new();
    let mut input_items: Vec<Value> = Vec::new();

    for message in messages {
        let role = message
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or("user");
        let Some(text) = message
            .get("content")
            .and_then(extract_text_from_message_content)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };

        if role.eq_ignore_ascii_case("system") {
            instructions_parts.push(text);
            continue;
        }

        let normalized_role = if role.eq_ignore_ascii_case("assistant") {
            "assistant"
        } else {
            "user"
        };
        input_items.push(json!({
            "role": normalized_role,
            "content": [{ "type": "input_text", "text": text }]
        }));
    }

    if !input_items.is_empty() {
        root.insert("input".to_string(), Value::Array(input_items));
    }

    if !instructions_parts.is_empty()
        && root
            .get("instructions")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
    {
        root.insert(
            "instructions".to_string(),
            Value::String(instructions_parts.join("\n\n")),
        );
    }
}

fn extract_text_from_message_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    let Some(items) = content.as_array() else {
        return None;
    };

    let mut chunks: Vec<String> = Vec::new();
    for item in items {
        if let Some(text) = item.as_str() {
            let text = text.trim();
            if !text.is_empty() {
                chunks.push(text.to_string());
            }
            continue;
        }
        if let Some(text) = item
            .get("text")
            .or_else(|| item.get("input_text"))
            .and_then(|value| value.as_str())
        {
            let text = text.trim();
            if !text.is_empty() {
                chunks.push(text.to_string());
            }
        }
    }

    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n"))
    }
}

fn extract_system_instruction_from_input(input: &Value) -> Option<String> {
    let items = input.as_array()?;
    let mut chunks: Vec<String> = Vec::new();

    for item in items {
        let role = item
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if !role.eq_ignore_ascii_case("system") {
            continue;
        }
        let Some(content) = item.get("content") else {
            continue;
        };
        if let Some(text) = extract_text_from_message_content(content) {
            let text = text.trim();
            if !text.is_empty() {
                chunks.push(text.to_string());
            }
        }
    }

    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n\n"))
    }
}

fn extract_output_text_from_response(response: &Value) -> Option<String> {
    if let Some(text) = response.get("output_text").and_then(|value| value.as_str()) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    let output_items = response.get("output").and_then(|value| value.as_array())?;
    let mut chunks: Vec<String> = Vec::new();

    for item in output_items {
        if let Some(role) = item.get("role").and_then(|value| value.as_str()) {
            if role != "assistant" {
                continue;
            }
        }
        let Some(content_items) = item.get("content").and_then(|value| value.as_array()) else {
            continue;
        };
        for content in content_items {
            if let Some(text) = content.get("text").and_then(|value| value.as_str()) {
                let text = text.trim();
                if !text.is_empty() {
                    chunks.push(text.to_string());
                }
            }
        }
    }

    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n"))
    }
}

fn build_synthesized_codex_response(
    output_text: Option<String>,
    requested_model: Option<&str>,
) -> Value {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    let text = output_text.unwrap_or_default();
    let output = if text.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "id": format!("msg_local_{}", now_ms),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }],
        })]
    };

    json!({
        "id": format!("resp_local_{}", now_ms),
        "object": "response",
        "created_at": now_ms / 1000,
        "status": "completed",
        "model": requested_model.unwrap_or("gpt-5-codex"),
        "output_text": text,
        "output": output,
    })
}

fn parse_codex_non_stream_response(raw: &[u8], requested_model: Option<&str>) -> Value {
    if let Ok(value) = serde_json::from_slice::<Value>(raw) {
        return value;
    }

    let text = String::from_utf8_lossy(raw);
    if text.trim().is_empty() {
        return build_synthesized_codex_response(None, requested_model);
    }

    let mut delta_text = String::new();
    let mut completed_response: Option<Value> = None;
    let mut stream_error: Option<Value> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let payload = trimmed.trim_start_matches("data:").trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        if stream_error.is_none() {
            stream_error = event.get("error").cloned();
        }
        match event.get("type").and_then(|value| value.as_str()) {
            Some("response.output_text.delta") => {
                if let Some(delta) = event.get("delta").and_then(|value| value.as_str()) {
                    delta_text.push_str(delta);
                }
            }
            Some("response.output_text.done") => {
                if delta_text.trim().is_empty() {
                    if let Some(done_text) = event.get("text").and_then(|value| value.as_str()) {
                        delta_text = done_text.to_string();
                    }
                }
            }
            Some("response.completed") => {
                if let Some(response) = event.get("response") {
                    completed_response = Some(response.clone());
                }
            }
            _ => {}
        }
    }

    if let Some(mut response) = completed_response {
        let output_text = if delta_text.trim().is_empty() {
            extract_output_text_from_response(&response)
        } else {
            Some(delta_text.trim().to_string())
        };
        if let Some(text) = output_text {
            if let Some(root) = response.as_object_mut() {
                let has_text = root
                    .get("output_text")
                    .and_then(|value| value.as_str())
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false);
                if !has_text {
                    root.insert("output_text".to_string(), Value::String(text));
                }
            }
        }
        return response;
    }

    if let Some(error) = stream_error {
        return json!({ "error": error });
    }

    let output_text = if delta_text.trim().is_empty() {
        None
    } else {
        Some(delta_text.trim().to_string())
    };
    build_synthesized_codex_response(output_text, requested_model)
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
            })
            .or_else(|| {
                json.get("detail")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_codex_non_stream_response_extracts_completed_payload() {
        let sse = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"gateway\"}\n\n",
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"-ok\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5-codex\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"gateway-ok\"}]}]}}\n\n",
            "data: [DONE]\n\n"
        );
        let parsed = parse_codex_non_stream_response(sse.as_bytes(), Some("gpt-5-codex"));
        let output_text = parsed
            .get("output_text")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        assert_eq!(output_text, "gateway-ok");
        assert_eq!(
            parsed
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            "resp_1"
        );
    }

    #[test]
    fn normalize_codex_chat_completions_payload_converts_messages() {
        let mut payload = serde_json::json!({
            "model": "gpt-5-codex",
            "messages": [
                { "role": "system", "content": "Use Chinese." },
                { "role": "user", "content": "你好" }
            ],
            "max_tokens": 128
        });
        let root = payload
            .as_object_mut()
            .expect("payload should be object for test");
        normalize_codex_chat_completions_payload(root);

        assert!(root.get("messages").is_none());
        assert_eq!(
            root.get("instructions")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            "Use Chinese."
        );
        assert_eq!(
            root.get("max_output_tokens")
                .and_then(|value| value.as_i64())
                .unwrap_or_default(),
            128
        );

        let input = root
            .get("input")
            .and_then(|value| value.as_array())
            .expect("input should be converted");
        assert_eq!(input.len(), 1);
        assert_eq!(
            input[0]
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            "user"
        );
    }
}
