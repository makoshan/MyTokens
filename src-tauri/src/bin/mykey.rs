//! `mykey` — headless CLI for the MyKey vault.
//!
//! Reuses `app_lib::vault::Vault` directly against the same encrypted SQLite
//! vault (`vault.db`, WAL) the desktop app uses, so the 密钥库 (secret store),
//! crypto wallet creation, and API-key retrieval are all scriptable.
//!
//! Build:  `cargo build --features cli-tools --bin mykey` (from `src-tauri/`)
//! Master password: `$MYKEY_MASTER_PASSWORD` or interactive prompt (never argv).
//! Vault path: `$MYKEY_VAULT_DB` or `--db <path>` (else the desktop app default).
//! Wallet keygen: shells out to the tcx-wasm sidecar (`$MYKEY_TCX_SIDECAR` or
//! `scripts/tcx-keygen.mjs`) so keystores stay byte-compatible with the GUI.

use std::io::{IsTerminal, Read, Write};
use std::process::{Command, Stdio};

use app_lib::vault::Vault;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "mykey", version, about = "MyKey headless vault CLI", long_about = None)]
struct Cli {
    /// Override the vault DB path (else $MYKEY_VAULT_DB or the desktop app default).
    #[arg(long, global = true)]
    db: Option<String>,
    /// Emit machine-readable JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Vault lifecycle: status / init.
    #[command(subcommand)]
    Vault(VaultCmd),
    /// Stored API credentials (the 密钥库).
    #[command(subcommand)]
    Secret(SecretCmd),
    /// Crypto wallets: create / import / watch / list / export.
    #[command(subcommand)]
    Wallet(WalletCmd),
    /// API keys: wallet data providers + AI providers.
    #[command(subcommand)]
    Apikey(ApikeyCmd),
    /// Compute-gateway access credentials.
    #[command(subcommand)]
    Gateway(GatewayCmd),
}

#[derive(Subcommand)]
enum VaultCmd {
    /// Show whether the vault is initialized and its unlock methods.
    Status,
    /// Set the master password (first run); optionally mint a recovery key.
    Init {
        /// Also initialize unlock methods and print a one-time recovery key.
        #[arg(long)]
        recovery: bool,
    },
}

#[derive(Subcommand)]
enum SecretCmd {
    /// List stored credentials (keys masked unless --reveal).
    List {
        #[arg(long)]
        reveal: bool,
    },
    /// Add a credential. Omit --key to read the secret from stdin / a hidden prompt.
    Add {
        #[arg(long)]
        provider: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        source: Option<String>,
    },
    /// Show one credential; --reveal prints the full decrypted secret.
    Get {
        id: String,
        #[arg(long)]
        reveal: bool,
    },
    /// Delete a credential by id.
    Rm { id: String },
}

#[derive(Subcommand)]
enum WalletCmd {
    /// List wallets and their accounts.
    List,
    /// Create a brand-new wallet (random mnemonic) via tcx-wasm.
    Create {
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "ETHEREUM")]
        chain: String,
        #[arg(long, default_value = "MAINNET")]
        network: String,
        /// Keystore unlock secret (the GUI uses a per-wallet secret). Prompted if omitted.
        #[arg(long)]
        unlock_secret: Option<String>,
        /// Import this mnemonic instead of generating a random one.
        #[arg(long)]
        mnemonic: Option<String>,
    },
    /// Import an existing wallet from a mnemonic or a keystore JSON file.
    Import {
        #[arg(long)]
        name: String,
        #[arg(long)]
        mnemonic: Option<String>,
        /// Path to an existing tcx keystore JSON file.
        #[arg(long)]
        keystore: Option<String>,
        #[arg(long, default_value = "ETHEREUM")]
        chain: String,
        #[arg(long, default_value = "MAINNET")]
        network: String,
        #[arg(long)]
        unlock_secret: Option<String>,
    },
    /// Register a watch-only address (no secret material).
    Watch {
        #[arg(long)]
        name: String,
        #[arg(long)]
        address: String,
        #[arg(long, default_value = "ETHEREUM")]
        chain: String,
        #[arg(long, default_value = "MAINNET")]
        network: String,
    },
    /// Export a wallet's stored secret material; --reveal prints it in full.
    Export {
        id: String,
        #[arg(long)]
        reveal: bool,
    },
    /// Delete a wallet by id.
    Rm { id: String },
}

#[derive(Subcommand)]
enum ApikeyCmd {
    /// Wallet data-provider keys (alchemy / oklink).
    #[command(subcommand)]
    Wallet(ApikeyWalletCmd),
    /// List configured AI providers.
    Providers,
}

#[derive(Subcommand)]
enum ApikeyWalletCmd {
    /// Show resolved alchemy/oklink keys and their source (.env vs vault).
    Get,
    /// Persist a wallet API key into the vault (alchemy | oklink).
    Set { name: String, value: String },
}

#[derive(Subcommand)]
enum GatewayCmd {
    /// Print gateway access credentials for an app type (e.g. claude_code, codex).
    Creds { app_type: String },
}

fn main() {
    let cli = Cli::parse();
    if let Some(db) = &cli.db {
        if !db.trim().is_empty() {
            std::env::set_var("MYKEY_VAULT_DB", db.trim());
        }
    }
    if let Err(err) = run(&cli) {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run(cli: &Cli) -> Result<(), String> {
    match &cli.command {
        Cmd::Vault(cmd) => run_vault(cli, cmd),
        Cmd::Secret(cmd) => run_secret(cli, cmd),
        Cmd::Wallet(cmd) => run_wallet(cli, cmd),
        Cmd::Apikey(cmd) => run_apikey(cli, cmd),
        Cmd::Gateway(cmd) => run_gateway(cli, cmd),
    }
}

// ---- vault ----------------------------------------------------------------

fn run_vault(cli: &Cli, cmd: &VaultCmd) -> Result<(), String> {
    match cmd {
        VaultCmd::Status => {
            let vault = Vault::new();
            let configured = vault.is_password_set();
            let unlock = vault.get_vault_unlock_state()?;
            if cli.json {
                print_json(&json!({ "configured": configured, "unlock": unlock }));
            } else {
                println!("vault configured : {configured}");
                println!("passkey unlocks  : {}", unlock.passkeys.len());
                println!("recovery key set : {}", unlock.has_recovery_key);
            }
            Ok(())
        }
        VaultCmd::Init { recovery } => {
            let mut vault = Vault::new();
            if vault.is_password_set() {
                return Err("vault already initialized (master password is set)".into());
            }
            let pw = prompt_new_password()?;
            vault.set_master_password(&pw)?;
            if !vault.authenticate(&pw) {
                return Err("internal: authentication failed right after set".into());
            }
            // initialize_vault_unlock_methods creates the vault crypto header AND
            // mints the recovery key, so it must run before ensure_secret_encryption
            // (which would otherwise create the header first and suppress the key).
            let recovery_key = if *recovery {
                vault.initialize_vault_unlock_methods(&pw)?
            } else {
                vault.ensure_secret_encryption(&pw);
                None
            };
            if cli.json {
                print_json(&json!({ "ok": true, "recoveryKey": recovery_key }));
            } else {
                println!("vault initialized.");
                if let Some(key) = recovery_key {
                    println!("\nRECOVERY KEY (store it now, shown once):\n  {key}");
                }
            }
            Ok(())
        }
    }
}

// ---- secret ---------------------------------------------------------------

fn run_secret(cli: &Cli, cmd: &SecretCmd) -> Result<(), String> {
    let (mut vault, _pw) = open_authed(cli)?;
    match cmd {
        SecretCmd::List { reveal } => {
            let creds = vault.get_credentials();
            if cli.json {
                let items: Vec<Value> = creds
                    .iter()
                    .map(|c| {
                        json!({
                            "id": c.id, "provider": c.provider, "name": c.name,
                            "key": if *reveal { c.key.clone() } else { mask(&c.key) },
                            "source": c.source, "isActive": c.is_active, "createdAt": c.created_at,
                        })
                    })
                    .collect();
                print_json(&json!(items));
            } else if creds.is_empty() {
                println!("(no credentials)");
            } else {
                for c in &creds {
                    let shown = if *reveal { c.key.clone() } else { mask(&c.key) };
                    println!("{}  {:<14} {:<20} {}", c.id, c.provider, c.name, shown);
                }
            }
            Ok(())
        }
        SecretCmd::Add {
            provider,
            name,
            key,
            source,
        } => {
            let secret = match key {
                Some(k) => k.clone(),
                None => read_secret_input("Secret value: ")?,
            };
            let cred = vault.add_credential(provider.clone(), name.clone(), secret, source.clone())?;
            if cli.json {
                print_json(&json!({ "id": cred.id, "provider": cred.provider, "name": cred.name }));
            } else {
                println!("added credential {} ({} / {})", cred.id, cred.provider, cred.name);
            }
            Ok(())
        }
        SecretCmd::Get { id, reveal } => {
            let cred = vault
                .get_credentials()
                .into_iter()
                .find(|c| c.id == *id)
                .ok_or_else(|| format!("no credential with id {id}"))?;
            let full = vault.get_credential_secret(id);
            let shown = match (reveal, &full) {
                (true, Some(v)) => v.clone(),
                (_, Some(v)) => mask(v),
                (_, None) => String::new(),
            };
            if cli.json {
                print_json(&json!({
                    "id": cred.id, "provider": cred.provider, "name": cred.name,
                    "key": shown, "source": cred.source,
                }));
            } else {
                println!("id      : {}", cred.id);
                println!("provider: {}", cred.provider);
                println!("name    : {}", cred.name);
                println!("key     : {shown}");
            }
            Ok(())
        }
        SecretCmd::Rm { id } => {
            vault.delete_credential(id)?;
            if cli.json {
                print_json(&json!({ "ok": true, "id": id }));
            } else {
                println!("deleted {id}");
            }
            Ok(())
        }
    }
}

// ---- wallet ---------------------------------------------------------------

fn run_wallet(cli: &Cli, cmd: &WalletCmd) -> Result<(), String> {
    let (mut vault, _pw) = open_authed(cli)?;
    match cmd {
        WalletCmd::List => {
            let wallets = vault.get_crypto_wallets()?;
            if cli.json {
                print_json(&serde_json::to_value(&wallets).map_err(|e| e.to_string())?);
            } else if wallets.is_empty() {
                println!("(no wallets)");
            } else {
                for w in &wallets {
                    let addr = w.accounts.first().map(|a| a.address.as_str()).unwrap_or("-");
                    println!("{}  {:<18} {:<22} {}", w.id, w.name, w.wallet_type, addr);
                }
            }
            Ok(())
        }
        WalletCmd::Create {
            name,
            chain,
            network,
            unlock_secret,
            mnemonic,
        } => {
            let secret = resolve_unlock_secret(unlock_secret, true)?;
            let req = json!({
                "unlockSecret": secret,
                "network": network,
                "mnemonic": mnemonic,
                "derivation": build_derivation(chain, network, None),
            });
            let res = run_tcx_sidecar(&req)?;
            store_tcx_wallet(cli, &mut vault, name, chain, network, &res)
        }
        WalletCmd::Import {
            name,
            mnemonic,
            keystore,
            chain,
            network,
            unlock_secret,
        } => {
            if mnemonic.is_none() && keystore.is_none() {
                return Err("provide --mnemonic or --keystore".into());
            }
            let keystore_json = match keystore {
                Some(path) => Some(
                    std::fs::read_to_string(path).map_err(|e| format!("read keystore: {e}"))?,
                ),
                None => None,
            };
            let secret = resolve_unlock_secret(unlock_secret, false)?;
            let req = json!({
                "unlockSecret": secret,
                "network": network,
                "mnemonic": mnemonic,
                "keystoreJson": keystore_json,
                "derivation": build_derivation(chain, network, None),
            });
            let res = run_tcx_sidecar(&req)?;
            store_tcx_wallet(cli, &mut vault, name, chain, network, &res)
        }
        WalletCmd::Watch {
            name,
            address,
            chain,
            network,
        } => {
            let derivation = build_derivation(chain, network, None);
            let path = derivation["derivationPath"].as_str().map(String::from);
            let wallet = vault.add_crypto_wallet(
                name.clone(),
                "hardware-watch".into(),
                "watch_only".into(),
                String::new(),
                chain.clone(),
                network.clone(),
                address.clone(),
                path,
                None,
                None,
                None,
            )?;
            report_wallet(cli, &wallet)
        }
        WalletCmd::Export { id, reveal } => {
            let material = vault.get_crypto_wallet_secret(id)?;
            let shown = if *reveal { material.clone() } else { mask(&material) };
            if cli.json {
                print_json(&json!({ "id": id, "secret": shown }));
            } else {
                println!("{shown}");
            }
            Ok(())
        }
        WalletCmd::Rm { id } => {
            vault.delete_crypto_wallet(id)?;
            if cli.json {
                print_json(&json!({ "ok": true, "id": id }));
            } else {
                println!("deleted {id}");
            }
            Ok(())
        }
    }
}

fn store_tcx_wallet(
    cli: &Cli,
    vault: &mut Vault,
    name: &str,
    chain: &str,
    network: &str,
    res: &Value,
) -> Result<(), String> {
    let keystore_json = res
        .get("keystoreJson")
        .and_then(|v| v.as_str())
        .ok_or("sidecar returned no keystoreJson")?;
    let accounts = res.get("accounts").and_then(|v| v.as_array());
    let account = accounts.and_then(|a| a.first());
    let address = account
        .and_then(|a| a.get("address"))
        .and_then(|v| v.as_str())
        .ok_or("sidecar derived no address")?;
    let derivation_path = account
        .and_then(|a| a.get("derivationPath"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| build_derivation(chain, network, None)["derivationPath"].as_str().map(String::from));
    let wallet = vault.add_crypto_wallet(
        name.to_string(),
        // Match the GUI's stored `walletType` so it can unlock + sign later.
        "tcx-wasm:password".into(),
        "keystore_json".into(),
        keystore_json.to_string(),
        chain.to_string(),
        network.to_string(),
        address.to_string(),
        derivation_path,
        None,
        None,
        None,
    )?;
    report_wallet(cli, &wallet)
}

fn report_wallet(cli: &Cli, wallet: &app_lib::CryptoWallet) -> Result<(), String> {
    if cli.json {
        print_json(&serde_json::to_value(wallet).map_err(|e| e.to_string())?);
    } else {
        let addr = wallet.accounts.first().map(|a| a.address.as_str()).unwrap_or("-");
        println!("created wallet {} ({})", wallet.id, wallet.name);
        println!("  type   : {}", wallet.wallet_type);
        println!("  address: {addr}");
    }
    Ok(())
}

// ---- apikey ---------------------------------------------------------------

fn run_apikey(cli: &Cli, cmd: &ApikeyCmd) -> Result<(), String> {
    let (vault, _pw) = open_authed(cli)?;
    match cmd {
        ApikeyCmd::Wallet(ApikeyWalletCmd::Get) => {
            // Mirror the get_wallet_api_keys command: .env wins over the vault.
            let env = vault.wallet_env_keys();
            let resolve = |env_name: &str, vault_name: &str| -> (String, String) {
                if let Some(v) = env
                    .get(env_name)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    return (v, "env".into());
                }
                if let Some(v) = vault.get_wallet_api_key_vault(vault_name) {
                    return (v, "vault".into());
                }
                (String::new(), "none".into())
            };
            let (alchemy, alchemy_src) = resolve("ALCHEMY_API_KEY", "alchemy");
            let (oklink, oklink_src) = resolve("OKLINK_API_KEY", "oklink");
            if cli.json {
                print_json(&json!({
                    "alchemy": alchemy, "alchemySource": alchemy_src,
                    "oklink": oklink, "oklinkSource": oklink_src,
                    "envPath": vault.wallet_env_path_string(),
                }));
            } else {
                println!("alchemy [{alchemy_src}]: {}", mask(&alchemy));
                println!("oklink  [{oklink_src}]: {}", mask(&oklink));
                println!(".env    : {}", vault.wallet_env_path_string());
            }
            Ok(())
        }
        ApikeyCmd::Wallet(ApikeyWalletCmd::Set { name, value }) => {
            let key = name.trim().to_ascii_lowercase();
            if key != "alchemy" && key != "oklink" {
                return Err("name must be 'alchemy' or 'oklink'".into());
            }
            vault.set_wallet_api_key(&key, value)?;
            if cli.json {
                print_json(&json!({ "ok": true, "name": key }));
            } else {
                println!("stored {key} api key in vault");
            }
            Ok(())
        }
        ApikeyCmd::Providers => {
            let providers = vault.get_providers();
            if cli.json {
                let items: Vec<Value> = providers
                    .iter()
                    .map(|p| {
                        json!({
                            "provider": p.provider, "label": p.label, "baseUrl": p.base_url,
                            "isActive": p.is_active, "hasKey": !p.api_key.trim().is_empty(),
                            "models": p.models,
                        })
                    })
                    .collect();
                print_json(&json!(items));
            } else if providers.is_empty() {
                println!("(no providers)");
            } else {
                for p in &providers {
                    let has = if p.api_key.trim().is_empty() { "no-key" } else { "key" };
                    let active = if p.is_active { "active" } else { "off" };
                    println!("{:<16} {:<8} {:<7} {}", p.provider, active, has, p.base_url);
                }
            }
            Ok(())
        }
    }
}

// ---- gateway --------------------------------------------------------------

fn run_gateway(cli: &Cli, cmd: &GatewayCmd) -> Result<(), String> {
    let (vault, _pw) = open_authed(cli)?;
    match cmd {
        GatewayCmd::Creds { app_type } => {
            let creds = vault.get_gateway_access_credentials(app_type)?;
            if cli.json {
                print_json(&serde_json::to_value(&creds).map_err(|e| e.to_string())?);
            } else {
                println!("appType : {}", creds.app_type);
                println!("provider: {}", creds.provider);
                println!("baseUrl : {}", creds.base_url);
                println!("model   : {}", creds.model.as_deref().unwrap_or("-"));
                println!("apiKey  : {}", mask(&creds.api_key));
            }
            Ok(())
        }
    }
}

// ---- helpers --------------------------------------------------------------

/// Open the vault and authenticate with the resolved master password.
fn open_authed(_cli: &Cli) -> Result<(Vault, String), String> {
    let mut vault = Vault::new();
    if !vault.is_password_set() {
        return Err("vault is not initialized — run `mykey vault init` first".into());
    }
    let pw = resolve_master_password()?;
    if !vault.authenticate(&pw) {
        return Err("invalid master password".into());
    }
    vault.ensure_secret_encryption(&pw);
    Ok((vault, pw))
}

fn resolve_master_password() -> Result<String, String> {
    if let Ok(pw) = std::env::var("MYKEY_MASTER_PASSWORD") {
        if !pw.is_empty() {
            return Ok(pw);
        }
    }
    rpassword::prompt_password("Master password: ").map_err(|e| e.to_string())
}

fn prompt_new_password() -> Result<String, String> {
    if let Ok(pw) = std::env::var("MYKEY_MASTER_PASSWORD") {
        if !pw.is_empty() {
            return Ok(pw);
        }
    }
    let pw = rpassword::prompt_password("New master password: ").map_err(|e| e.to_string())?;
    if pw.is_empty() {
        return Err("password must not be empty".into());
    }
    let confirm = rpassword::prompt_password("Confirm: ").map_err(|e| e.to_string())?;
    if pw != confirm {
        return Err("passwords do not match".into());
    }
    Ok(pw)
}

/// Resolve a per-wallet keystore unlock secret. When prompting for a new wallet
/// (`confirm`), require it to be entered twice.
fn resolve_unlock_secret(arg: &Option<String>, confirm: bool) -> Result<String, String> {
    if let Some(s) = arg {
        if !s.is_empty() {
            return Ok(s.clone());
        }
    }
    if let Ok(s) = std::env::var("MYKEY_WALLET_UNLOCK_SECRET") {
        if !s.is_empty() {
            return Ok(s);
        }
    }
    let s = rpassword::prompt_password("Wallet unlock secret: ").map_err(|e| e.to_string())?;
    if s.is_empty() {
        return Err("unlock secret must not be empty".into());
    }
    if confirm {
        let c = rpassword::prompt_password("Confirm: ").map_err(|e| e.to_string())?;
        if s != c {
            return Err("unlock secrets do not match".into());
        }
    }
    Ok(s)
}

/// Read a secret value: from a pipe if stdin is not a TTY, else a hidden prompt.
fn read_secret_input(prompt: &str) -> Result<String, String> {
    if std::io::stdin().is_terminal() {
        rpassword::prompt_password(prompt).map_err(|e| e.to_string())
    } else {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| e.to_string())?;
        Ok(buf.trim_end_matches(['\n', '\r']).to_string())
    }
}

/// Derivation defaults mirroring src/components/CryptoWalletManager.tsx.
fn build_derivation(chain: &str, network: &str, path: Option<&str>) -> Value {
    let chain_u = chain.to_ascii_uppercase();
    let default_path = match chain_u.as_str() {
        "ETHEREUM" => "m/44'/60'/0'/0/0",
        "TRON" => "m/44'/195'/0'/0/0",
        "BITCOIN" => "m/84'/0'/0'/0/0",
        "COSMOS" => "m/44'/118'/0'/0/0",
        "SOLANA" => "m/44'/501'/0'/0'",
        _ => "m/44'/60'/0'/0/0",
    };
    let chain_id = match chain_u.as_str() {
        "ETHEREUM" => Some("1"),
        "BASE" => Some("8453"),
        "ARBITRUM" => Some("42161"),
        "OPTIMISM" => Some("10"),
        "POLYGON" => Some("137"),
        _ => None,
    };
    let mut d = json!({
        "chain": chain_u,
        "network": network.to_ascii_uppercase(),
        "derivationPath": path.unwrap_or(default_path),
    });
    if let Some(id) = chain_id {
        d["chainId"] = json!(id);
    }
    if chain_u == "BITCOIN" {
        d["segWit"] = json!("VERSION_0");
    }
    d
}

/// Locate and run the tcx-wasm keygen sidecar, exchanging JSON over stdin/stdout.
fn run_tcx_sidecar(req: &Value) -> Result<Value, String> {
    let script = locate_sidecar()?;
    let mut child = Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn node ({}): {e}", script))?;
    child
        .stdin
        .take()
        .ok_or("no sidecar stdin")?
        .write_all(req.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("sidecar output not JSON: {e}: {stdout}"))?;
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(format!("tcx sidecar: {err}"));
    }
    if !output.status.success() {
        return Err("tcx sidecar exited non-zero".into());
    }
    Ok(parsed)
}

fn locate_sidecar() -> Result<String, String> {
    if let Ok(p) = std::env::var("MYKEY_TCX_SIDECAR") {
        if !p.trim().is_empty() {
            return Ok(p.trim().to_string());
        }
    }
    for cand in [
        "scripts/tcx-keygen.mjs",
        "../scripts/tcx-keygen.mjs",
        "../../scripts/tcx-keygen.mjs",
    ] {
        if std::path::Path::new(cand).exists() {
            return Ok(cand.to_string());
        }
    }
    Err("tcx sidecar not found — set $MYKEY_TCX_SIDECAR to scripts/tcx-keygen.mjs".into())
}

fn mask(value: &str) -> String {
    let v = value.trim();
    if v.is_empty() {
        return String::new();
    }
    if v.len() <= 8 {
        return "********".into();
    }
    format!("{}…{}", &v[..4], &v[v.len() - 4..])
}

fn print_json(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()));
}
