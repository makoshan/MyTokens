use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value;
use std::time::Duration;

fn truncate_text(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }
    let mut out = trimmed.chars().take(max_len).collect::<String>();
    out.push_str("...");
    out
}

fn extract_error_message(parsed: &Value) -> Option<String> {
    let candidates = [
        ("message", None),
        ("detail", None),
        ("error", Some("message")),
        ("error", Some("detail")),
    ];
    for (key, nested) in candidates {
        if let Some(inner) = parsed.get(key) {
            if let Some(nested_key) = nested {
                if let Some(value) = inner.get(nested_key).and_then(|v| v.as_str()) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            } else if let Some(value) = inner.as_str() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

pub fn normalize_model_id(input: &str) -> String {
    let raw = input.trim();
    match raw.to_ascii_lowercase().as_str() {
        "" => "scribe_v2".to_string(),
        "scribe" | "scribe-v1" | "scribe_v1" => "scribe_v1".to_string(),
        "scribe-v2" | "scribe_v2" => "scribe_v2".to_string(),
        other => other.to_string(),
    }
}

pub fn normalize_language_code(input: Option<&str>) -> Option<String> {
    let raw = input.unwrap_or("").trim();
    if raw.is_empty() || raw == "auto" {
        return None;
    }
    Some(raw.to_string())
}

pub async fn transcribe(
    endpoint: &str,
    api_key: &str,
    model_id: &str,
    language_code: Option<&str>,
    file_name: &str,
    audio_bytes: Vec<u8>,
    mut headers: HeaderMap,
    timeout: Duration,
) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("ElevenLabs endpoint is empty".to_string());
    }
    let url = if endpoint.ends_with("/speech-to-text") {
        endpoint.to_string()
    } else {
        format!("{}/speech-to-text", endpoint)
    };

    let key = api_key.trim();
    if !key.is_empty() && !headers.contains_key("xi-api-key") {
        let value = HeaderValue::from_str(key).map_err(|e| e.to_string())?;
        headers.insert("xi-api-key", value);
    }

    let model_id = normalize_model_id(model_id);
    let language_code = normalize_language_code(language_code);

    let mut form = reqwest::multipart::Form::new().text("model_id", model_id);
    if let Some(code) = language_code {
        form = form.text("language_code", code);
    }
    form = form.text("temperature", "0");

    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(file_name.trim().to_string())
        .mime_str("audio/wav")
        .map_err(|e| format!("Invalid audio mime: {}", e))?;
    form = form.part("file", part);

    let response = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .headers(headers)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("STT request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = extract_error_message(&parsed).unwrap_or_else(|| truncate_text(&body, 220));
        return Err(format!(
            "ElevenLabs STT HTTP {}: {}",
            status.as_u16(),
            detail
        ));
    }

    if let Some(text) = parsed
        .get("text")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return Ok(text);
    }

    if let Some(transcripts) = parsed.get("transcripts").and_then(|v| v.as_array()) {
        let mut parts: Vec<String> = Vec::new();
        for item in transcripts {
            if let Some(text) = item
                .get("text")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            {
                parts.push(text);
            }
        }
        if !parts.is_empty() {
            return Ok(parts.join("\n"));
        }
    }

    Err(format!(
        "ElevenLabs STT returned empty text: {}",
        truncate_text(&body, 240)
    ))
}
