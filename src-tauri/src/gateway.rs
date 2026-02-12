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
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::oneshot;

const DEFAULT_GATEWAY_PORT: i64 = 8888;
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_COMPACT_URL: &str = "https://chatgpt.com/backend-api/codex/responses/compact";

#[derive(Default)]
pub struct GatewayRuntime {
    port: Option<u16>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct GatewayContext {
    client: reqwest::Client,
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

        let context = GatewayContext { client };
        let app = Router::new()
            .route("/health", get(health))
            .route("/models", get(models))
            .route("/v1/models", get(models))
            .route("/responses", post(relay_responses))
            .route("/v1/responses", post(relay_responses))
            .route("/responses/compact", post(relay_responses_compact))
            .route("/v1/responses/compact", post(relay_responses_compact))
            .route("/chat/completions", post(chat_not_supported))
            .route("/v1/chat/completions", post(chat_not_supported))
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
        ],
    })
}

async fn chat_not_supported() -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "/v1/chat/completions is not supported by Codex relay. Use /v1/responses.",
        "not_implemented",
    )
}

async fn relay_responses(
    State(ctx): State<GatewayContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    relay_to_codex(ctx, headers, body, false).await
}

async fn relay_responses_compact(
    State(ctx): State<GatewayContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    relay_to_codex(ctx, headers, body, true).await
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

    if let Some(value) = header_value(&headers, "openai-beta") {
        request = request.header("openai-beta", value);
    }
    if let Some(value) = header_value(&headers, "version") {
        request = request.header("version", value);
    }
    if let Some(value) =
        header_value(&headers, "session_id").or_else(|| header_value(&headers, "x-session-id"))
    {
        request = request.header("session_id", value);
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
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;

    for (name, value) in &upstream_headers {
        if should_pass_header(name) {
            response.headers_mut().insert(name.clone(), value.clone());
        }
    }
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
    ) {
        return true;
    }
    name.as_str().starts_with("x-codex-")
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
