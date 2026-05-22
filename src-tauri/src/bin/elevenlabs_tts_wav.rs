use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

fn get_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_flag_value(args: &[String], name: &str) -> Option<String> {
    let mut i = 0usize;
    while i < args.len() {
        if args[i] == name {
            if i + 1 < args.len() {
                return Some(args[i + 1].clone());
            }
            return None;
        }
        i += 1;
    }
    None
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|v| v == name)
}

fn parse_u32(value: &str) -> Option<u32> {
    value.trim().parse::<u32>().ok()
}

fn wav_header_pcm16le(sample_rate: u32, channels: u16, data_len: u32) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let bytes_per_sample = (bits_per_sample / 8) as u16;
    let byte_rate = sample_rate * channels as u32 * bytes_per_sample as u32;
    let block_align = channels * bytes_per_sample;

    let riff_chunk_size = 36u32.saturating_add(data_len);
    let mut out = Vec::with_capacity(44);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_chunk_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out
}

fn extract_error_message(value: &Value) -> Option<String> {
    if let Some(msg) = value.get("detail").and_then(|v| v.as_str()) {
        let trimmed = msg.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(msg) = value.get("message").and_then(|v| v.as_str()) {
        let trimmed = msg.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(msg) = value
        .get("error")
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
    {
        let trimmed = msg.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn usage() {
    println!(
        "Usage:\n  cargo run -p app --bin elevenlabs_tts_wav -- --voice-id <id> [--text <text>] [--out <file.wav>]\n  cargo run -p app --bin elevenlabs_tts_wav -- --list-voices\n\nEnv vars:\n  ELEVENLABS_API_KEY (required)\n  ELEVENLABS_BASE_URL (default: https://api.elevenlabs.io)\n  ELEVENLABS_VOICE_ID (optional)\n  ELEVENLABS_TTS_MODEL_ID (default: eleven_multilingual_v2)\n\nNotes:\n  - This uses output_format=pcm_16000 and wraps raw PCM into a WAV container.\n"
    );
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || has_flag(&args, "--help") || has_flag(&args, "-h") {
        usage();
        return Ok(());
    }

    let api_key = get_env("ELEVENLABS_API_KEY")
        .ok_or_else(|| "ELEVENLABS_API_KEY is required".to_string())?;
    let base_url =
        get_env("ELEVENLABS_BASE_URL").unwrap_or_else(|| "https://api.elevenlabs.io".to_string());
    let model_id =
        get_env("ELEVENLABS_TTS_MODEL_ID").unwrap_or_else(|| "eleven_multilingual_v2".to_string());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    if has_flag(&args, "--list-voices") {
        let url = format!("{}/v1/voices", base_url.trim_end_matches('/'));
        let response = client
            .get(&url)
            .header("xi-api-key", api_key.trim())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
            let detail = extract_error_message(&parsed).unwrap_or(body);
            return Err(format!(
                "List voices failed (HTTP {}): {}",
                status.as_u16(),
                detail
            ));
        }
        println!("{}", body);
        return Ok(());
    }

    let voice_id = parse_flag_value(&args, "--voice-id")
        .or_else(|| get_env("ELEVENLABS_VOICE_ID"))
        .ok_or_else(|| "Missing --voice-id (or set ELEVENLABS_VOICE_ID)".to_string())?;

    let text = parse_flag_value(&args, "--text")
        .unwrap_or_else(|| "语音输入测试，我说的是语音输入测试。".to_string());

    let out = parse_flag_value(&args, "--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let mut path = env::temp_dir();
            path.push("mykey-elevenlabs-tts.wav");
            path
        });

    let output_format = "pcm_16000";
    let sample_rate = output_format
        .strip_prefix("pcm_")
        .and_then(parse_u32)
        .unwrap_or(16000);
    let channels: u16 = 1;

    let url = format!(
        "{}/v1/text-to-speech/{}/stream?output_format={}",
        base_url.trim_end_matches('/'),
        voice_id.trim(),
        output_format
    );

    let payload = json!({
        "text": text,
        "model_id": model_id,
        "language_code": "zh",
    });

    let response = client
        .post(&url)
        .header("xi-api-key", api_key.trim())
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes).to_string();
        let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
        let detail = extract_error_message(&parsed).unwrap_or(body);
        return Err(format!("TTS failed (HTTP {}): {}", status.as_u16(), detail));
    }

    let data_len = u32::try_from(bytes.len()).map_err(|_| "Audio too large".to_string())?;
    let mut wav = wav_header_pcm16le(sample_rate, channels, data_len);
    wav.extend_from_slice(&bytes);
    fs::write(&out, wav).map_err(|e| format!("Failed to write wav: {}", e))?;

    println!("{}", out.display());
    Ok(())
}
