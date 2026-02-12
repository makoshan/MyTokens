use super::{CostUsage, UsageQuota, UsageSnapshot};
use chrono::{Duration, Utc};
use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

pub fn probe_claude_cli(
    provider_id: &str,
    cli_path_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    let binary_path = resolve_claude_binary(cli_path_override)?;

    // Try /usage first
    match run_claude_command(&binary_path, "/usage") {
        Ok(output) => {
            // Check if it's the "subscription required" error (API Usage Billing) or similar fallback triggers
            // Note: "available for subscription plans", "API Usage Billing", etc.
            if output.contains("for subscription plans") || output.contains("API Usage Billing") {
                // Fallback to /cost
                parse_claude_cost(&run_claude_command(&binary_path, "/cost")?, provider_id)
            } else {
                match parse_claude_usage(&output, provider_id) {
                    Ok(snapshot) => Ok(snapshot),
                    Err(parse_err) => {
                        let cost_out = run_claude_command(&binary_path, "/cost")
                            .map_err(|cost_err| format!("{}; {}", parse_err, cost_err))?;
                        parse_claude_cost(&cost_out, provider_id)
                    }
                }
            }
        }
        Err(e) => {
            // If /usage failed hard (e.g. "Missing OpenAI API key" or other fatal), try /cost
            if let Ok(cost_out) = run_claude_command(&binary_path, "/cost") {
                parse_claude_cost(&cost_out, provider_id)
            } else {
                Err(e) // Return original error if both fail
            }
        }
    }
}

pub fn probe_amp_cli(
    provider_id: &str,
    cli_path_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    let binary_path = resolve_amp_binary(cli_path_override)?;
    let output = run_amp_command(&binary_path)?;
    parse_amp_usage(&output, provider_id)
}

pub fn probe_gemini_cli(
    provider_id: &str,
    cli_path_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    let binary_path = resolve_gemini_binary(cli_path_override)?;
    let output = run_interactive_command(&binary_path, &[], "/stats\n/quit\n", 7)?;
    parse_gemini_usage(&output, provider_id)
}

pub fn probe_kimi_cli(
    provider_id: &str,
    cli_path_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    let binary_path = resolve_kimi_binary(cli_path_override)?;

    let mut errors = Vec::new();
    let attempts: [(&[&str], Option<&str>); 3] = [
        (&["usage", "--no-color"], None),
        (&["usage"], None),
        (&[], Some("/usage\n/quit\n")),
    ];

    for (args, input) in attempts {
        let output = if let Some(input_text) = input {
            run_interactive_command(&binary_path, args, input_text, 7)
        } else {
            run_non_interactive_command(&binary_path, args)
        };
        let output = match output {
            Ok(value) => value,
            Err(err) => {
                errors.push(err);
                continue;
            }
        };
        match parse_kimi_usage(&output, provider_id) {
            Ok(snapshot) => return Ok(snapshot),
            Err(err) => errors.push(err),
        }
    }

    Err(format!(
        "Kimi CLI probe failed: {}",
        errors.join("; ")
    ))
}

fn run_claude_command(binary_path: &str, command_arg: &str) -> Result<String, String> {
    // Use system temp dir to avoid project-specific config interference
    let temp_dir = std::env::temp_dir();

    let mut child = Command::new(binary_path)
        .args(&[command_arg, "--allowed-tools", ""])
        .current_dir(&temp_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{} {}': {}", binary_path, command_arg, e))?;

    // Pipe "1" to stdin to handle potential Trust Prompt
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "1");
    }

    // Wait a bit for output (since TUI keeps running interactively)
    // 5 seconds should be enough for "Brewing..." and output
    thread::sleep(StdDuration::from_secs(5));

    // Kill the process securely
    let _ = child.kill();

    // Collect output
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read output: {}", e))?;

    // Combine stdout and stderr
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let raw = format!("{}\n{}", stdout, stderr);
    Ok(strip_ansi(&raw))
}

fn resolve_claude_binary(cli_path_override: Option<&str>) -> Result<String, String> {
    resolve_binary(
        cli_path_override,
        "CLAUDE_CLI_PATH",
        "claude",
        "Claude CLI binary not found. Install Claude Code CLI or set CLAUDE_CLI_PATH.",
    )
}

fn resolve_amp_binary(cli_path_override: Option<&str>) -> Result<String, String> {
    resolve_binary(
        cli_path_override,
        "AMP_CLI_PATH",
        "amp",
        "Amp CLI binary not found. Install Amp CLI or set AMP_CLI_PATH.",
    )
}

fn resolve_gemini_binary(cli_path_override: Option<&str>) -> Result<String, String> {
    resolve_binary(
        cli_path_override,
        "GEMINI_CLI_PATH",
        "gemini",
        "Gemini CLI binary not found. Install Gemini CLI or set GEMINI_CLI_PATH.",
    )
}

fn resolve_kimi_binary(cli_path_override: Option<&str>) -> Result<String, String> {
    resolve_binary_candidates(
        cli_path_override,
        "KIMI_CLI_PATH",
        &["kimi", "kimi-coding"],
        "Kimi CLI binary not found. Install Kimi Coding CLI or set KIMI_CLI_PATH.",
    )
}

fn resolve_binary(
    cli_path_override: Option<&str>,
    override_var_name: &str,
    fallback_binary: &str,
    missing_message: &str,
) -> Result<String, String> {
    if let Some(raw_override) = cli_path_override {
        let trimmed = raw_override.trim();
        if !trimmed.is_empty() {
            if let Some(path) = find_binary(trimmed) {
                return Ok(path);
            }
            return Err(format!(
                "Configured {} '{}' is not executable or not found",
                override_var_name,
                trimmed
            ));
        }
    }

    if let Some(path) = find_binary(fallback_binary) {
        return Ok(path);
    }

    Err(missing_message.to_string())
}

fn resolve_binary_candidates(
    cli_path_override: Option<&str>,
    override_var_name: &str,
    fallback_binaries: &[&str],
    missing_message: &str,
) -> Result<String, String> {
    if let Some(raw_override) = cli_path_override {
        let trimmed = raw_override.trim();
        if !trimmed.is_empty() {
            if let Some(path) = find_binary(trimmed) {
                return Ok(path);
            }
            return Err(format!(
                "Configured {} '{}' is not executable or not found",
                override_var_name,
                trimmed
            ));
        }
    }

    for binary in fallback_binaries {
        if let Some(path) = find_binary(binary) {
            return Ok(path);
        }
    }

    Err(missing_message.to_string())
}

fn run_amp_command(binary_path: &str) -> Result<String, String> {
    run_non_interactive_command(binary_path, &["usage", "--no-color"])
        .map_err(|err| format!("amp usage failed: {}", err))
}

fn run_non_interactive_command(binary_path: &str, args: &[&str]) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let output = Command::new(binary_path)
        .args(args)
        .current_dir(&temp_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run '{}': {}", binary_path, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let merged = format!("{}\n{}", stdout, stderr);
    let cleaned = strip_ansi(&merged);

    if !output.status.success() {
        let message = cleaned.trim();
        if message.is_empty() {
            return Err(format!("{} returned non-zero exit code", binary_path));
        }
        return Err(message.to_string());
    }

    Ok(cleaned)
}

fn run_interactive_command(
    binary_path: &str,
    args: &[&str],
    input: &str,
    wait_secs: u64,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let mut child = Command::new(binary_path)
        .args(args)
        .current_dir(&temp_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", binary_path, e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = write!(stdin, "{}", input);
    }

    thread::sleep(StdDuration::from_secs(wait_secs));
    let _ = child.kill();
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read output: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(strip_ansi(&format!("{}\n{}", stdout, stderr)))
}

fn find_binary(candidate: &str) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains('/') || trimmed.starts_with('~') {
        let expanded = expand_user_home(trimmed);
        let path = Path::new(&expanded);
        if is_executable(path) {
            return Some(expanded);
        }
        return None;
    }

    find_in_env_path(trimmed)
        .or_else(|| find_in_common_paths(trimmed))
        .or_else(|| find_via_login_shell(trimmed))
}

fn find_in_env_path(binary: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn find_in_common_paths(binary: &str) -> Option<String> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];

    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("bin"));
    }

    for dir in dirs {
        let candidate = dir.join(binary);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn find_via_login_shell(binary: &str) -> Option<String> {
    let safe = binary
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    if !safe {
        return None;
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(shell)
        .args(["-l", "-c", &format!("which {}", binary)])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resolved = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())?
        .to_string();

    if is_executable(Path::new(&resolved)) {
        return Some(resolved);
    }
    None
}

fn expand_user_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

fn is_executable(path: &Path) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        return metadata.permissions().mode() & 0o111 != 0;
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn strip_ansi(s: &str) -> String {
    let re =
        Regex::new(r"[\u001b\u009b]\[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]")
            .unwrap();
    re.replace_all(s, "").to_string()
}

fn infer_quota_type(label: &str) -> String {
    let lower = label.to_ascii_lowercase();
    if lower.contains("session") || lower.contains("5h") || lower.contains("five") {
        "session".to_string()
    } else if lower.contains("week") || lower.contains("7d") || lower.contains("seven") {
        "weekly".to_string()
    } else if lower.contains("sonnet") {
        "seven_day_sonnet".to_string()
    } else if lower.contains("opus") {
        "seven_day_opus".to_string()
    } else {
        "window".to_string()
    }
}

fn normalize_quota_label(label: &str, quota_type: &str) -> String {
    let trimmed = label
        .trim()
        .trim_matches(|c: char| c == ':' || c == '-' || c == '.');
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    match quota_type {
        "session" => "Session".to_string(),
        "weekly" => "Weekly".to_string(),
        "seven_day_sonnet" => "Sonnet".to_string(),
        "seven_day_opus" => "Opus".to_string(),
        _ => "Quota".to_string(),
    }
}

fn parse_reset_from_line(line: &str) -> (Option<String>, Option<String>) {
    let reset_in_re = Regex::new(r"(?i)resets?\s+in\s+((?:\d+\s*h\s*)?(?:\d+\s*m)?)").unwrap();
    let reset_at_re = Regex::new(r"(?i)resets?\s+at\s+([0-9T:\-+Z\.]{10,})").unwrap();

    if let Some(caps) = reset_in_re.captures(line) {
        if let Some(m) = caps.get(1) {
            let text = m.as_str().replace(' ', "");
            if !text.is_empty() {
                let reset_at = parse_relative_time(&text)
                    .ok()
                    .map(|duration| (Utc::now() + duration).to_rfc3339());
                return (Some(text), reset_at);
            }
        }
    }

    if let Some(caps) = reset_at_re.captures(line) {
        if let Some(m) = caps.get(1) {
            let raw = m.as_str().trim().to_string();
            if !raw.is_empty() {
                return (Some(raw.clone()), Some(raw));
            }
        }
    }

    (None, None)
}

fn parse_claude_usage(stdout: &str, provider_id: &str) -> Result<UsageSnapshot, String> {
    let mut quotas = Vec::new();

    // Clean output for easier regex
    let clean_out = stdout.replace("\r", "\n");
    let lower_out = clean_out.to_ascii_lowercase();

    if lower_out.contains("missing openai api key") {
        return Err("Missing OpenAI API key in provider settings".to_string());
    }
    if lower_out.contains("not logged in")
        || lower_out.contains("please log in")
        || lower_out.contains("authentication required")
    {
        return Err("Claude CLI not logged in".to_string());
    }

    let line_re = Regex::new(
        r"(?i)^(?P<label>[A-Za-z][A-Za-z0-9 .()/_-]{1,80}?)\s*[:\-]?\s*(?P<pct>\d{1,3}(?:\.\d+)?)\s*%\s*(?P<mode>left|remaining|used)?",
    )
    .unwrap();
    let fallback_pct_re = Regex::new(
        r"(?i)(?:currently|session|weekly|sonnet|opus)[^0-9]*(?P<pct>\d{1,3}(?:\.\d+)?)\s*%",
    )
    .unwrap();
    let mut seen = HashSet::new();

    let lines: Vec<String> = clean_out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect();

    for (idx, line) in lines.iter().enumerate() {
        let caps = match line_re.captures(line) {
            Some(caps) => caps,
            None => continue,
        };

        let pct = match caps
            .name("pct")
            .and_then(|m| m.as_str().parse::<f64>().ok())
        {
            Some(v) => v.clamp(0.0, 100.0),
            None => continue,
        };
        let raw_label = caps.name("label").map(|m| m.as_str()).unwrap_or("Session");
        let mode = caps
            .name("mode")
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        let is_used = mode == "used" || line.to_ascii_lowercase().contains(" used");
        let percent_remaining = if is_used { 100.0 - pct } else { pct };
        let quota_type = infer_quota_type(raw_label);
        let label = normalize_quota_label(raw_label, &quota_type);

        let dedup_key = format!("{}:{}", quota_type, label.to_ascii_lowercase());
        if seen.contains(&dedup_key) {
            continue;
        }

        let (mut reset_text, mut reset_at) = parse_reset_from_line(line);
        if reset_text.is_none() {
            if let Some(next_line) = lines.get(idx + 1) {
                let parsed = parse_reset_from_line(next_line);
                reset_text = parsed.0;
                reset_at = parsed.1;
            }
        }

        quotas.push(UsageQuota {
            quota_type,
            label,
            percent_remaining: percent_remaining.clamp(0.0, 100.0),
            reset_at,
            reset_text,
        });
        seen.insert(dedup_key);
    }

    if quotas.is_empty() {
        if let Some(caps) = fallback_pct_re.captures(&clean_out) {
            if let Some(used_pct) = caps
                .name("pct")
                .and_then(|m| m.as_str().parse::<f64>().ok())
            {
                quotas.push(UsageQuota {
                    quota_type: "session".to_string(),
                    label: "Session".to_string(),
                    percent_remaining: (100.0 - used_pct).clamp(0.0, 100.0),
                    reset_at: None,
                    reset_text: None,
                });
            }
        }
    }

    if quotas.is_empty() {
        return Err("No quota windows parsed from Claude CLI output".to_string());
    }

    Ok(UsageSnapshot {
        provider_id: provider_id.to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage: None,
        account_tier: Some("Pro (CLI)".to_string()),
        account_email: None,
    })
}

fn parse_claude_cost(stdout: &str, provider_id: &str) -> Result<UsageSnapshot, String> {
    // Check for errors in output first
    if stdout.contains("Missing OpenAI API key") {
        return Err("Missing OpenAI API key in provider settings".to_string());
    }

    // Parse /cost output and tolerate format changes.
    let re_total =
        Regex::new(r"(?i)(?:total|this month|monthly)[^\$]*\$\s*([\d]+(?:\.\d+)?)").unwrap();
    let re_any_money = Regex::new(r"\$\s*([\d]+(?:\.\d+)?)").unwrap();

    let mut total_cost = 0.0;

    if let Some(caps) = re_total.captures(stdout) {
        if let Some(cost_match) = caps.get(1) {
            total_cost = cost_match.as_str().parse::<f64>().unwrap_or(0.0);
        }
    } else if let Some(caps) = re_any_money.captures(stdout) {
        if let Some(cost_match) = caps.get(1) {
            total_cost = cost_match.as_str().parse::<f64>().unwrap_or(0.0);
        }
    } else {
        // Did we get any useful output?
        if stdout.trim().is_empty() {
            return Err("No output from claude /cost".to_string());
        }
        // If we have output but no cost found, assume 0.0 or just return success with 0?
        // Maybe the user hasn't spent anything or format changed.
        // Let's log it or just default to 0.0
    }

    Ok(UsageSnapshot {
        provider_id: provider_id.to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas: vec![],
        cost_usage: Some(CostUsage {
            total_cost,
            budget: None, // We don't parse budget yet from CLI
        }),
        account_tier: Some("API (CLI)".to_string()),
        account_email: None,
    })
}

fn parse_amp_usage(stdout: &str, provider_id: &str) -> Result<UsageSnapshot, String> {
    let clean_out = stdout.replace("\r", "\n");
    let lower_out = clean_out.to_ascii_lowercase();
    if lower_out.contains("not logged in")
        || lower_out.contains("sign in")
        || lower_out.contains("authentication")
    {
        return Err("Amp CLI not logged in".to_string());
    }

    let email_re = Regex::new(r"(?i)signed in as\s+(\S+)\s+\(").unwrap();
    let credit_line_re = Regex::new(
        r"(?i)^(.+?):\s*\$([0-9]+(?:\.[0-9]+)?)\s*/\s*\$([0-9]+(?:\.[0-9]+)?)\s+remaining",
    )
    .unwrap();

    let account_email = email_re
        .captures(&clean_out)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()));

    let mut quotas = Vec::new();
    let mut account_tier = None;
    for line in clean_out.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Some(caps) = credit_line_re.captures(line) else {
            continue;
        };
        let Some(label_match) = caps.get(1) else {
            continue;
        };
        let Some(remaining_match) = caps.get(2) else {
            continue;
        };
        let Some(total_match) = caps.get(3) else {
            continue;
        };

        let label = label_match.as_str().trim().to_string();
        let remaining = remaining_match.as_str().parse::<f64>().unwrap_or(0.0);
        let total = total_match.as_str().parse::<f64>().unwrap_or(0.0);
        if total <= 0.0 {
            continue;
        }

        let percent_remaining = ((remaining / total) * 100.0).clamp(0.0, 100.0);
        if account_tier.is_none() && label.to_ascii_lowercase().contains("free") {
            account_tier = Some("Free".to_string());
        }

        quotas.push(UsageQuota {
            quota_type: "amp_credit".to_string(),
            label,
            percent_remaining,
            reset_at: None,
            reset_text: None,
        });
    }

    if quotas.is_empty() {
        return Err("No quota windows parsed from amp usage output".to_string());
    }

    Ok(UsageSnapshot {
        provider_id: provider_id.to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage: None,
        account_tier,
        account_email,
    })
}

fn parse_gemini_usage(stdout: &str, provider_id: &str) -> Result<UsageSnapshot, String> {
    let clean_out = stdout.replace("\r", "\n");
    let lower_out = clean_out.to_ascii_lowercase();
    if lower_out.contains("login with google")
        || lower_out.contains("authentication required")
        || lower_out.contains("waiting for auth")
    {
        return Err("Gemini CLI not logged in".to_string());
    }

    // Matches table style output like: gemini-2.5-pro ... 100.0% (Resets in 24h)
    let model_line_re =
        Regex::new(r"(?i)(gemini[-\w.]+)\s+.*?([0-9]+(?:\.[0-9]+)?)\s*%\s*\(([^)]+)\)").unwrap();

    let mut quotas = Vec::new();
    for raw_line in clean_out.lines() {
        let line = raw_line.trim().replace('│', " ");
        let Some(caps) = model_line_re.captures(&line) else {
            continue;
        };
        let Some(label_match) = caps.get(1) else {
            continue;
        };
        let Some(pct_match) = caps.get(2) else {
            continue;
        };
        let percent_remaining = pct_match
            .as_str()
            .parse::<f64>()
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
        let reset_text = caps.get(3).map(|m| m.as_str().trim().to_string());

        quotas.push(UsageQuota {
            quota_type: "model".to_string(),
            label: label_match.as_str().trim().to_string(),
            percent_remaining,
            reset_at: None,
            reset_text,
        });
    }

    if quotas.is_empty() {
        quotas = parse_generic_percent_quotas(&clean_out)?;
    }

    Ok(UsageSnapshot {
        provider_id: provider_id.to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage: None,
        account_tier: None,
        account_email: None,
    })
}

fn parse_kimi_usage(stdout: &str, provider_id: &str) -> Result<UsageSnapshot, String> {
    let clean_out = stdout.replace("\r", "\n");
    let lower_out = clean_out.to_ascii_lowercase();
    if lower_out.contains("not logged in")
        || lower_out.contains("please login")
        || lower_out.contains("authentication required")
    {
        return Err("Kimi CLI not logged in".to_string());
    }

    let quotas = parse_generic_percent_quotas(&clean_out)?;
    Ok(UsageSnapshot {
        provider_id: provider_id.to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage: None,
        account_tier: None,
        account_email: None,
    })
}

fn parse_generic_percent_quotas(text: &str) -> Result<Vec<UsageQuota>, String> {
    let line_re = Regex::new(
        r"(?i)^(?P<label>[A-Za-z][A-Za-z0-9 .()/_:-]{1,100}?)\s*[:\-]?\s*(?P<pct>\d{1,3}(?:\.\d+)?)\s*%\s*(?P<mode>left|remaining|used)?(?:\s*\((?P<reset>[^)]+)\))?",
    )
    .unwrap();
    let credit_line_re = Regex::new(
        r"(?i)^(.+?):\s*\$([0-9]+(?:\.[0-9]+)?)\s*/\s*\$([0-9]+(?:\.[0-9]+)?)\s+remaining",
    )
    .unwrap();
    let mut quotas = Vec::new();
    let mut seen = HashSet::new();

    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(caps) = credit_line_re.captures(line) {
            let label = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_else(|| "Credit".to_string());
            let remaining = caps
                .get(2)
                .and_then(|m| m.as_str().parse::<f64>().ok())
                .unwrap_or(0.0);
            let total = caps
                .get(3)
                .and_then(|m| m.as_str().parse::<f64>().ok())
                .unwrap_or(0.0);
            if total <= 0.0 {
                continue;
            }
            let percent_remaining = ((remaining / total) * 100.0).clamp(0.0, 100.0);
            let key = label.to_ascii_lowercase();
            if seen.insert(key) {
                quotas.push(UsageQuota {
                    quota_type: "credit".to_string(),
                    label,
                    percent_remaining,
                    reset_at: None,
                    reset_text: None,
                });
            }
            continue;
        }

        let Some(caps) = line_re.captures(line) else {
            continue;
        };
        let pct = caps
            .name("pct")
            .and_then(|m| m.as_str().parse::<f64>().ok())
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
        let raw_label = caps
            .name("label")
            .map(|m| m.as_str())
            .unwrap_or("Quota");
        let mode = caps
            .name("mode")
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        let is_used = mode == "used" || line.to_ascii_lowercase().contains(" used");
        let percent_remaining = if is_used { 100.0 - pct } else { pct };
        let label = normalize_quota_label(raw_label, "window");
        let key = label.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let reset_text = caps.name("reset").map(|m| m.as_str().trim().to_string());
        quotas.push(UsageQuota {
            quota_type: "window".to_string(),
            label,
            percent_remaining: percent_remaining.clamp(0.0, 100.0),
            reset_at: None,
            reset_text,
        });
    }

    if quotas.is_empty() {
        return Err("No quota windows parsed from CLI output".to_string());
    }

    Ok(quotas)
}

fn parse_relative_time(text: &str) -> Result<Duration, String> {
    let re_h = Regex::new(r"(\d+)h").unwrap();
    let re_m = Regex::new(r"(\d+)m").unwrap();

    let hours = re_h
        .captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
        .unwrap_or(0);

    let minutes = re_m
        .captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
        .unwrap_or(0);
    Ok(Duration::hours(hours) + Duration::minutes(minutes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi() {
        let input = "\u{1b}[31mRed\u{1b}[0m";
        assert_eq!(strip_ansi(input), "Red");
    }
}
