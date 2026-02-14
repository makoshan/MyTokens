use reqwest::header::HeaderMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

fn get_env(key: &str) -> Option<String> {
    env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
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

fn run_ffmpeg_list_devices() -> Result<(), String> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]) 
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if text.trim().is_empty() {
        return Err("ffmpeg returned empty output".to_string());
    }
    println!("{}", text);
    Ok(())
}

fn record_with_ffmpeg(device: &str, seconds: u64, out_path: &PathBuf) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "avfoundation",
            "-i",
            device,
            "-t",
            &seconds.to_string(),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            out_path
                .to_str()
                .ok_or_else(|| "Invalid output path".to_string())?,
        ])
        .status()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    if !status.success() {
        return Err(format!("ffmpeg failed: {}", status));
    }
    Ok(())
}

fn main() -> Result<(), String> {
    tauri::async_runtime::block_on(async_main())
}

async fn async_main() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if has_flag(&args, "--help") || has_flag(&args, "-h") {
        println!(
            "Usage:\n  cargo run -p app --bin elevenlabs_stt_test -- --file <path.wav>\n  cargo run -p app --bin elevenlabs_stt_test -- --record-seconds 3 [--device :0]\n\nEnv vars:\n  ELEVENLABS_API_KEY (required)\n  ELEVENLABS_BASE_URL (default: https://api.elevenlabs.io/v1)\n  ELEVENLABS_MODEL_ID (default: scribe_v2)\n  ELEVENLABS_LANGUAGE_CODE (default: zh)\n\nOptions:\n  --list-devices   List avfoundation devices (requires ffmpeg)\n  --debug          Print more details\n"
        );
        return Ok(());
    }

    if has_flag(&args, "--list-devices") {
        return run_ffmpeg_list_devices();
    }

    let api_key = get_env("ELEVENLABS_API_KEY").ok_or_else(|| "ELEVENLABS_API_KEY is required".to_string())?;
    let base_url = get_env("ELEVENLABS_BASE_URL").unwrap_or_else(|| "https://api.elevenlabs.io/v1".to_string());
    let model_id = get_env("ELEVENLABS_MODEL_ID").unwrap_or_else(|| "scribe_v2".to_string());
    let language_code = get_env("ELEVENLABS_LANGUAGE_CODE").unwrap_or_else(|| "zh".to_string());
    let debug = has_flag(&args, "--debug");

    let file_arg = parse_flag_value(&args, "--file");
    let record_seconds = parse_flag_value(&args, "--record-seconds")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let device = parse_flag_value(&args, "--device").unwrap_or_else(|| ":0".to_string());

    let wav_path = if let Some(path) = file_arg {
        PathBuf::from(path)
    } else if let Some(seconds) = record_seconds {
        let mut out_path = env::temp_dir();
        out_path.push("mykey-elevenlabs-test.wav");
        record_with_ffmpeg(&device, seconds.max(1).min(30), &out_path)?;
        out_path
    } else {
        return Err("Provide --file <path.wav> or --record-seconds <n>".to_string());
    };

    let audio_bytes = fs::read(&wav_path).map_err(|e| format!("Failed to read wav file: {}", e))?;
    if audio_bytes.len() < 128 {
        return Err("Wav file is too small".to_string());
    }

    if debug {
        eprintln!("Using wav: {} ({} bytes)", wav_path.display(), audio_bytes.len());
        eprintln!("Base URL: {}", base_url);
        eprintln!("Model: {}", model_id);
        eprintln!("Language: {}", language_code);
    }

    let text = app_lib::stt::elevenlabs::transcribe(
        &base_url,
        &api_key,
        &model_id,
        Some(&language_code),
        "voice.wav",
        audio_bytes,
        HeaderMap::new(),
        Duration::from_secs(60),
    )
    .await?;

    println!("{}", text);
    Ok(())
}
