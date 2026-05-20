# MyKey Crypto Wallet Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish MyKey as a local-first AI Token/API Key and Crypto Wallet vault with password/passkey unlock, ETH/TRON/BTC account management, balances, EVM send flows, verification, docs, and fresh app/DMG artifacts.

**Architecture:** Keep MyKey's existing Tauri + React structure, but move security-sensitive wallet unlock state out of long-lived React state and into short-lived Rust sessions. Use tcx-wasm for HD wallet create/derive/sign, Rust commands for RPC/balance/broadcast, SQLite for metadata, and the secret store/vault crypto layer for sealed secrets.

**Tech Stack:** React 19 + TypeScript + Vite, Tauri 2, Rust, rusqlite, reqwest, @consenlabs/tcx-wasm, Node test runner, Cargo tests.

---

## Completion Definition

The work is complete only when all of these are true:

- `Docs_code/Mykey 产品文档.md` exists and the implemented wallet behavior matches it.
- Frontend no longer keeps mnemonic, private key, tcx keystore JSON, API keys, or master password in long-lived component state.
- Password and passkey PRF can unlock an app session; unsupported PRF environments present a password fallback.
- Wallet creation/import supports password tcx wallet, passkey tcx wallet, mnemonic import, tcx keystore JSON import, and watch-only addresses.
- ETH, TRON, and BTC Native SegWit addresses can be derived and stored with `network`, `derivationPath`, `address`, `publicKey`, and `extPubKey`.
- ETH native and ERC20 balances work through configured EVM RPC. TRON native/token and BTC balance work through configured explorer providers.
- EVM send flow supports ETH legacy, EIP-1559, ERC20 transfer, transaction summary confirmation, signing, broadcasting, hash display, and status refresh.
- Raw wasm errors and raw RPC errors are mapped to user-safe messages.
- Tests include Rust vault/session/storage tests, TS portfolio/RPC/input tests, tcx-wasm smoke tests, build checks, and manual E2E evidence.
- `npm run test:linkage`, `npm run test:gateway`, `npm run test:tcx`, `cargo test`, `npm run build`, and `npm run tauri:build:dmg` pass fresh.
- Fresh `.app` and universal `.dmg` artifacts are listed with timestamps and known limitations.

## File Structure

Create:

- `/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md` - product source of truth for AI assets + crypto wallet behavior.
- `/Users/thursday/go/play/mykey/Docs_code/crypto-wallet-release-checklist.md` - manual E2E checklist and signed-off limitations.
- `/Users/thursday/go/play/mykey/docs/crypto-wallet.md` - user-facing wallet usage guide.
- `/Users/thursday/go/play/mykey/docs/passkey-prf-compatibility.md` - user-facing compatibility and fallback guide.
- `/Users/thursday/go/play/mykey/docs/crypto-wallet-security.md` - recovery, backup, private key export, and risk guide.
- `/Users/thursday/go/play/mykey/scripts/test-codex-gateway.mjs` - restores the existing `npm run test:gateway` check.
- `/Users/thursday/go/play/mykey/scripts/test-tcx-wasm-smoke.mjs` - Node smoke test for tcx-wasm create/derive/export/sign.
- `/Users/thursday/go/play/mykey/src-tauri/src/auth_session.rs` - short-lived authenticated Rust session store.
- `/Users/thursday/go/play/mykey/src-tauri/src/crypto_rpc.rs` - chain RPC/explorer clients, balance helpers, status helpers.
- `/Users/thursday/go/play/mykey/src-tauri/src/wallet_errors.rs` - user-safe error mapping for wasm/RPC/vault errors.
- `/Users/thursday/go/play/mykey/src/utils/cryptoSession.ts` - frontend session API wrapper.
- `/Users/thursday/go/play/mykey/src/utils/cryptoRpc.ts` - typed frontend RPC provider helpers.
- `/Users/thursday/go/play/mykey/src/utils/walletValidation.ts` - send/import/address validation helpers.
- `/Users/thursday/go/play/mykey/tests/cryptoRpc.test.ts` - TS tests for RPC/provider helpers.
- `/Users/thursday/go/play/mykey/tests/walletValidation.test.ts` - TS tests for send/import validation.
- `/Users/thursday/go/play/mykey/src-tauri/tests/auth_session.rs` - Rust session tests.
- `/Users/thursday/go/play/mykey/src-tauri/tests/crypto_wallet_storage.rs` - Rust wallet metadata + sealed secret tests.

Modify:

- `/Users/thursday/go/play/mykey/package.json` - add test scripts and preserve existing commands.
- `/Users/thursday/go/play/mykey/tsconfig.tests.json` - include new TS test files.
- `/Users/thursday/go/play/mykey/src-tauri/src/lib.rs` - register new modules and commands.
- `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs` - add session/passkey/RPC/wallet commands and move crypto commands to session auth.
- `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs` - add wallet/account metadata columns, sealed secret storage, retry lockout metadata, tx records.
- `/Users/thursday/go/play/mykey/src-tauri/src/vault_crypto.rs` - add public helpers for vault-key based secret wrap/unwrap where needed.
- `/Users/thursday/go/play/mykey/src/App.tsx` - replace long-lived master password state with session state and passkey login UI.
- `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx` - split and complete wallet UX without long-lived secrets.
- `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.css` - polish complete flows and responsive states.
- `/Users/thursday/go/play/mykey/src/utils/tcxWallet.ts` - add export mnemonic, message signing where needed, and safe error mapping wrapper.
- `/Users/thursday/go/play/mykey/src/utils/passkeyPrf.ts` - add real PRF capability probe and fallback messaging.
- `/Users/thursday/go/play/mykey/src/utils/alchemyRpc.ts` - move API key persistence out of localStorage.
- `/Users/thursday/go/play/mykey/src/utils/oklinkApi.ts` - move API key persistence out of localStorage.
- `/Users/thursday/go/play/mykey/tests/assetVault.test.ts` - extend transaction validation tests.
- `/Users/thursday/go/play/mykey/tests/cryptoPortfolio.test.ts` - extend portfolio/flow tests.
- `/Users/thursday/go/play/mykey/src-tauri/tests/vault_crypto.rs` - extend passkey/recovery tests.

---

## Task 1: Restore Source Of Truth And Baseline Checks

**Files:**
- Create: `/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md`
- Create: `/Users/thursday/go/play/mykey/Docs_code/crypto-wallet-release-checklist.md`
- Create: `/Users/thursday/go/play/mykey/scripts/test-codex-gateway.mjs`
- Modify: `/Users/thursday/go/play/mykey/package.json`

- [ ] **Step 1: Create the product spec if the current file is absent**

Create `/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md` with this structure:

```markdown
# MyKey 产品文档

## 产品定位

MyKey 是本地优先的 AI Asset Vault，统一管理 AI Token/API Key、模型接入配置、项目绑定、使用监控，以及 Crypto Wallet 资产。

## Crypto Wallet 范围

MyKey 支持 password 和 passkey PRF 解锁 tcx-wasm HD 钱包；支持创建钱包、导入 mnemonic、导入 tcx keystore JSON、导入 watch-only 地址；支持派生 ETH、TRON、BTC Native SegWit 地址；支持查询 ETH/ERC20/TRON/BTC 余额；支持 EVM ETH/ERC20 构造、确认、签名、广播、交易 hash 和状态跟踪。

## 安全要求

前端不得长期保存 master password、mnemonic、private key、tcx keystore JSON、RPC API key。Rust 侧使用短期 session 认证；钱包 secret 进入 vault/secret store 前必须加密；watch-only 不保存签名材料。

## 交付要求

发布前必须通过 `npm run test:linkage`、`npm run test:gateway`、`npm run test:tcx`、`cargo test`、`npm run build`、`npm run tauri:build:dmg`，并完成 `Docs_code/crypto-wallet-release-checklist.md` 手动验收。
```

- [ ] **Step 2: Create the release checklist**

Create `/Users/thursday/go/play/mykey/Docs_code/crypto-wallet-release-checklist.md`:

```markdown
# Crypto Wallet Release Checklist

## Automated Checks

- [ ] `npm run test:linkage`
- [ ] `npm run test:gateway`
- [ ] `npm run test:tcx`
- [ ] `cargo test` from `src-tauri`
- [ ] `npm run build`
- [ ] `npm run tauri:build:dmg`

## Manual E2E

- [ ] Password login creates a short-lived app session.
- [ ] Passkey PRF login creates a short-lived app session on supported hardware.
- [ ] Unsupported PRF environment shows password fallback.
- [ ] Password wallet creation derives ETH, TRON, BTC Native SegWit addresses.
- [ ] Passkey wallet creation derives ETH, TRON, BTC Native SegWit addresses after app restart.
- [ ] Mnemonic import derives the expected ETH address.
- [ ] tcx keystore JSON import derives the expected ETH address.
- [ ] Watch-only address saves without secret material.
- [ ] ETH native balance refreshes through configured RPC.
- [ ] ERC20 balance refreshes through configured RPC.
- [ ] TRON native/token balance refreshes through configured explorer.
- [ ] BTC balance refreshes through configured explorer.
- [ ] ETH transfer signs and broadcasts on testnet.
- [ ] ERC20 transfer signs and broadcasts on testnet.
- [ ] Transaction status refresh shows pending/confirmed/failed.
- [ ] Lock clears session and prevents wallet actions until re-authentication.
- [ ] Recovery/export mnemonic requires confirmation and does not persist plaintext.

## Artifact Evidence

- [ ] `.app` path:
- [ ] `.dmg` path:
- [ ] Build timestamp:
- [ ] Known limitations:
```

- [ ] **Step 3: Restore `npm run test:gateway`**

Create `/Users/thursday/go/play/mykey/scripts/test-codex-gateway.mjs`:

```js
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync('cargo', ['test', 'gateway::tests', '--lib'], {
  cwd: resolve(root, 'src-tauri'),
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
```

- [ ] **Step 4: Add the tcx smoke script as an executable command target**

Modify `/Users/thursday/go/play/mykey/package.json` scripts:

```json
{
  "test:tcx": "node scripts/test-tcx-wasm-smoke.mjs"
}
```

Keep the existing `test:linkage` and `test:gateway` scripts.

- [ ] **Step 5: Run baseline checks**

Run:

```bash
npm run test:linkage
npm run test:gateway
npm run build
cd src-tauri && cargo test
```

Expected: `test:linkage`, `test:gateway`, `build`, and `cargo test` exit 0 before deeper work starts.

- [ ] **Step 6: Commit**

```bash
git add Docs_code package.json scripts/test-codex-gateway.mjs
git commit -m "chore: restore crypto wallet completion baseline"
```

---

## Task 2: Add Short-Lived Auth Sessions And Locking

**Files:**
- Create: `/Users/thursday/go/play/mykey/src-tauri/src/auth_session.rs`
- Create: `/Users/thursday/go/play/mykey/src-tauri/tests/auth_session.rs`
- Create: `/Users/thursday/go/play/mykey/src/utils/cryptoSession.ts`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/lib.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`
- Modify: `/Users/thursday/go/play/mykey/src/App.tsx`

- [ ] **Step 1: Write Rust tests for session creation, expiry, and lock**

Create `/Users/thursday/go/play/mykey/src-tauri/tests/auth_session.rs`:

```rust
use app_lib::auth_session::AuthSessionStore;
use std::{thread, time::Duration};

#[test]
fn session_store_creates_validates_and_locks_sessions() {
    let store = AuthSessionStore::new(Duration::from_millis(200));
    let session = store.create_session("master-pass").unwrap();

    assert!(store.validate(&session.session_id).is_ok());
    assert_eq!(store.master_password(&session.session_id).unwrap(), "master-pass");

    store.lock(&session.session_id);
    assert!(store.validate(&session.session_id).is_err());
}

#[test]
fn session_store_expires_sessions() {
    let store = AuthSessionStore::new(Duration::from_millis(10));
    let session = store.create_session("master-pass").unwrap();

    thread::sleep(Duration::from_millis(25));

    assert!(store.validate(&session.session_id).is_err());
}
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cd /Users/thursday/go/play/mykey/src-tauri
cargo test --test auth_session
```

Expected: FAIL because `app_lib::auth_session` does not exist.

- [ ] **Step 3: Implement the session store**

Create `/Users/thursday/go/play/mykey/src-tauri/src/auth_session.rs`:

```rust
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::Duration,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub session_id: String,
    pub expires_at: String,
}

#[derive(Clone, Debug)]
pub enum SessionSecret {
    MasterPassword(String),
    VaultKey(crate::vault_crypto::VaultKey),
}

#[derive(Clone, Debug)]
struct AuthSessionRecord {
    secret: SessionSecret,
    expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct AuthSessionStore {
    ttl: Duration,
    sessions: Mutex<HashMap<String, AuthSessionRecord>>,
}

impl AuthSessionStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(&self, master_password: &str) -> Result<AuthSession, String> {
        if master_password.is_empty() {
            return Err("Master password is required".to_string());
        }
        self.create_session_with_secret(SessionSecret::MasterPassword(master_password.to_string()))
    }

    pub fn create_vault_key_session(
        &self,
        vault_key: crate::vault_crypto::VaultKey,
    ) -> Result<AuthSession, String> {
        self.create_session_with_secret(SessionSecret::VaultKey(vault_key))
    }

    fn create_session_with_secret(&self, secret: SessionSecret) -> Result<AuthSession, String> {
        let session_id = random_session_id();
        let expires_at = Utc::now()
            + ChronoDuration::from_std(self.ttl).map_err(|e| e.to_string())?;
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(
                session_id.clone(),
                AuthSessionRecord {
                    secret,
                    expires_at,
                },
            );
        Ok(AuthSession {
            session_id,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    pub fn validate(&self, session_id: &str) -> Result<(), String> {
        self.master_password(session_id).map(|_| ())
    }

    pub fn master_password(&self, session_id: &str) -> Result<String, String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let Some(record) = sessions.get(session_id.trim()) else {
            return Err("Session is locked or expired".to_string());
        };
        if record.expires_at <= Utc::now() {
            sessions.remove(session_id.trim());
            return Err("Session is locked or expired".to_string());
        }
        match &record.secret {
            SessionSecret::MasterPassword(value) => Ok(value.clone()),
            SessionSecret::VaultKey(_) => Err("This session does not include a master password".to_string()),
        }
    }

    pub fn vault_key(&self, session_id: &str) -> Result<crate::vault_crypto::VaultKey, String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let Some(record) = sessions.get(session_id.trim()) else {
            return Err("Session is locked or expired".to_string());
        };
        if record.expires_at <= Utc::now() {
            sessions.remove(session_id.trim());
            return Err("Session is locked or expired".to_string());
        }
        match &record.secret {
            SessionSecret::VaultKey(value) => Ok(value.clone()),
            SessionSecret::MasterPassword(_) => Err("This session does not include a vault key".to_string()),
        }
    }

    pub fn lock(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id.trim());
        }
    }

    pub fn lock_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }
}

fn random_session_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
```

- [ ] **Step 4: Wire the module into app state**

Modify `/Users/thursday/go/play/mykey/src-tauri/src/lib.rs`:

```rust
pub mod auth_session;

pub struct AppState {
    pub vault: Arc<Mutex<Vault>>,
    pub sessions: Arc<auth_session::AuthSessionStore>,
    pub usage: Arc<Mutex<usage::UsageState>>,
    pub gateway: Arc<Mutex<gateway::GatewayRuntime>>,
    pub quick_runtime: Arc<Mutex<QuickRuntimeState>>,
    pub voice_runtime: Arc<voice_input::VoiceInputRuntime>,
}
```

Initialize with:

```rust
sessions: Arc::new(auth_session::AuthSessionStore::new(std::time::Duration::from_secs(15 * 60))),
```

- [ ] **Step 5: Add session commands**

Modify `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionPayload {
    pub session_id: String,
    pub expires_at: String,
}

#[tauri::command]
pub fn authenticate_session(
    password: String,
    state: State<'_, AppState>,
) -> Result<AuthSessionPayload, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&password) {
        return Err("Invalid master password".to_string());
    }
    drop(vault);
    let session = state.sessions.create_session(&password)?;
    Ok(AuthSessionPayload {
        session_id: session.session_id,
        expires_at: session.expires_at,
    })
}

#[tauri::command]
pub fn lock_session(session_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.sessions.lock(&session_id);
    Ok(true)
}
```

Register `authenticate_session` and `lock_session` in `tauri::generate_handler!`.

- [ ] **Step 6: Add frontend session wrapper**

Create `/Users/thursday/go/play/mykey/src/utils/cryptoSession.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

export type AuthSession = {
  sessionId: string
  expiresAt: string
}

export async function authenticateSession(password: string): Promise<AuthSession> {
  return invoke<AuthSession>('authenticate_session', { password })
}

export async function lockSession(sessionId: string): Promise<void> {
  await invoke<boolean>('lock_session', { sessionId })
}
```

- [ ] **Step 7: Replace login state shape in `App.tsx`**

Replace:

```ts
const [masterPassword, setMasterPassword] = useState('')
```

with:

```ts
const [authSession, setAuthSession] = useState<{ sessionId: string; expiresAt: string } | null>(null)
const sessionId = authSession?.sessionId || ''
```

Update `handleAuthenticate` to call `authenticateSession(password)` and then immediately clear the password field in `AuthForm` after submit.

- [ ] **Step 8: Add compatibility helpers for existing password commands and new vault-key commands**

Add this helper in `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`:

```rust
fn master_password_from_session(
    session_id: &str,
    state: &State<'_, AppState>,
) -> Result<String, String> {
    state.sessions.master_password(session_id)
}

fn vault_key_from_session(
    session_id: &str,
    state: &State<'_, AppState>,
) -> Result<crate::vault_crypto::VaultKey, String> {
    state.sessions.vault_key(session_id)
}
```

Use `master_password_from_session` for existing password-authenticated non-crypto commands. Use `vault_key_from_session` for crypto secret unwrap paths after Task 4 stores crypto secrets as vault-key sealed payloads.

- [ ] **Step 9: Run tests**

Run:

```bash
cd /Users/thursday/go/play/mykey/src-tauri
cargo test --test auth_session
cargo test
```

Expected: both commands exit 0.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/auth_session.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tests/auth_session.rs src/utils/cryptoSession.ts src/App.tsx
git commit -m "feat: add short-lived app auth sessions"
```

---

## Task 3: Complete Passkey PRF App Unlock

**Files:**
- Modify: `/Users/thursday/go/play/mykey/src/utils/passkeyPrf.ts`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`
- Modify: `/Users/thursday/go/play/mykey/src/App.tsx`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/tests/vault_crypto.rs`

- [ ] **Step 1: Add a test proving passkey PRF unlock returns the same vault key**

Extend `/Users/thursday/go/play/mykey/src-tauri/tests/vault_crypto.rs`:

```rust
#[test]
fn passkey_prf_unlock_rejects_missing_header_and_invalid_key_length() {
    let (header, _recovery_key) = create_vault_header("master password").unwrap();
    assert!(unlock_vault_key(&header, VaultUnlockRequest::PasskeyPrfKeyHex("abc")).is_err());
}
```

- [ ] **Step 2: Add passkey session command**

Modify `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn authenticate_passkey_prf_session(
    prf_key_hex: String,
    state: State<'_, AppState>,
) -> Result<AuthSessionPayload, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    let vault_key = vault.unlock_vault_key_with_passkey_prf(&prf_key_hex)?;
    drop(vault);

    let session = state.sessions.create_vault_key_session(vault_key)?;
    Ok(AuthSessionPayload {
        session_id: session.session_id,
        expires_at: session.expires_at,
    })
}
```

- [ ] **Step 3: Add the vault-key unlock method**

Add to `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`:

```rust
pub fn unlock_vault_key_with_passkey_prf(
    &self,
    prf_key_hex: &str,
) -> Result<crate::vault_crypto::VaultKey, String> {
    let Some(header) = self.load_vault_crypto_header()? else {
        return Err("Passkey unlock is not configured".to_string());
    };
    crate::vault_crypto::unlock_vault_key(
        &header,
        crate::vault_crypto::VaultUnlockRequest::PasskeyPrfKeyHex(prf_key_hex),
    )
}
```

- [ ] **Step 4: Add frontend capability probe**

Modify `/Users/thursday/go/play/mykey/src/utils/passkeyPrf.ts`:

```ts
export async function probePasskeyPrfSupport(): Promise<{ available: boolean; reason?: string }> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    return { available: false, reason: 'WebAuthn is not available in this webview.' }
  }
  if (!window.crypto?.subtle) {
    return { available: false, reason: 'Web Crypto is not available in this webview.' }
  }
  return { available: true }
}
```

- [ ] **Step 5: Add passkey login UI**

In `/Users/thursday/go/play/mykey/src/App.tsx`, extend `AuthForm` props:

```ts
interface AuthFormProps {
  onSubmit: (password: string) => void
  onAuthenticate: (password: string) => void
  onPasskeyAuthenticate: () => void
  passkeyAvailable: boolean
  defaultMode: 'setup' | 'login'
}
```

Add a button in login mode:

```tsx
{mode === 'login' && passkeyAvailable ? (
  <button type="button" className="btn btn-secondary" onClick={() => onPasskeyAuthenticate()}>
    使用 Passkey 解锁
  </button>
) : null}
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd /Users/thursday/go/play/mykey/src-tauri && cargo test --test vault_crypto
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/utils/passkeyPrf.ts src/App.tsx src-tauri/src/commands.rs src-tauri/tests/vault_crypto.rs
git commit -m "feat: add passkey prf app unlock entry"
```

---

## Task 4: Seal Crypto Secrets With Vault Key Boundaries

**Files:**
- Create: `/Users/thursday/go/play/mykey/src-tauri/tests/crypto_wallet_storage.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/vault_crypto.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`

- [ ] **Step 1: Write storage tests**

Create `/Users/thursday/go/play/mykey/src-tauri/tests/crypto_wallet_storage.rs`:

```rust
use app_lib::vault::Vault;

#[test]
fn watch_only_wallet_does_not_store_secret_material() {
    let mut vault = Vault::new();
    vault.set_master_password("master").unwrap();
    vault.initialize_vault_unlock_methods("master").unwrap();
    let wallet = vault.add_crypto_wallet(
        "Watch".to_string(),
        "hardware-watch".to_string(),
        "watch_only".to_string(),
        "".to_string(),
        "ETHEREUM".to_string(),
        "MAINNET".to_string(),
        "0x3535353535353535353535353535353535353535".to_string(),
        Some("m/44'/60'/0'/0/0".to_string()),
        None,
        None,
        None,
        None,
        None,
        None,
    ).unwrap();

    assert!(vault.get_crypto_wallet_secret(&wallet.id).is_err());
}
```

- [ ] **Step 2: Add vault-key unlock helpers for password sessions**

Add to `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`:

```rust
pub fn unlock_vault_key_with_master_password(
    &self,
    master_password: &str,
) -> Result<crate::vault_crypto::VaultKey, String> {
    let Some(header) = self.load_vault_crypto_header()? else {
        return Err("Vault unlock methods are not initialized".to_string());
    };
    crate::vault_crypto::unlock_vault_key(
        &header,
        crate::vault_crypto::VaultUnlockRequest::MasterPassword(master_password),
    )
}
```

- [ ] **Step 3: Store crypto wallet secret as sealed payload**

In `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`, change the non-watch wallet secret write to seal before writing to `SecretManager`:

```rust
let sealed = crate::vault_crypto::encrypt_secret(
    vault_key,
    secret_material.as_bytes(),
    secret_key_id.as_bytes(),
)?;
let secret = Secret {
    value: serde_json::to_string(&sealed).map_err(|e| e.to_string())?,
    metadata: SecretMetadata {
        provider: "crypto_wallet".to_string(),
        created_at: None,
        updated_at: None,
        tags: vec![wallet_type.clone(), secret_kind.clone()],
        note: Some("crypto_wallet_secret:vault-sealed".to_string()),
    },
};
```

Update `Vault::add_crypto_wallet` to accept:

```rust
vault_key: Option<&crate::vault_crypto::VaultKey>,
```

Return `"Wallet vault key is required"` when saving signing material without a vault key.

- [ ] **Step 4: Decrypt crypto wallet secret with session vault key**

Change `Vault::get_crypto_wallet_secret` signature:

```rust
pub fn get_crypto_wallet_secret(
    &self,
    id: &str,
    vault_key: &crate::vault_crypto::VaultKey,
) -> Result<String, String>
```

After reading the stored secret value:

```rust
let sealed: crate::vault_crypto::SealedSecret =
    serde_json::from_str(&secret.value).map_err(|_| "Wallet secret is not vault-sealed".to_string())?;
let plaintext = crate::vault_crypto::decrypt_secret(
    vault_key,
    &sealed,
    secret_key_id.as_bytes(),
)?;
String::from_utf8(plaintext).map_err(|_| "Wallet secret is not UTF-8".to_string())
```

- [ ] **Step 5: Add account public key metadata columns**

Modify migration SQL in `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`:

```sql
public_key TEXT,
ext_pub_key TEXT,
```

Add migrations:

```rust
Self::ensure_column(conn, "crypto_accounts", "public_key", "TEXT")?;
Self::ensure_column(conn, "crypto_accounts", "ext_pub_key", "TEXT")?;
```

- [ ] **Step 6: Extend `CryptoAccount`**

Modify `/Users/thursday/go/play/mykey/src-tauri/src/lib.rs`:

```rust
pub struct CryptoAccount {
    pub id: String,
    pub wallet_id: String,
    pub chain: String,
    pub network: String,
    pub address: String,
    pub derivation_path: Option<String>,
    pub public_key: Option<String>,
    pub ext_pub_key: Option<String>,
    pub created_at: String,
}
```

- [ ] **Step 7: Extend wallet/account insert APIs**

Change `Vault::add_crypto_wallet` and `Vault::add_crypto_account` signatures to accept:

```rust
public_key: Option<String>,
ext_pub_key: Option<String>,
```

Persist these values in `crypto_accounts`.

- [ ] **Step 8: Make crypto secret retrieval reject inactive and watch-only records**

In `get_crypto_wallet_secret`, reject:

```rust
if secret_kind == "watch_only" || secret_key_id.trim().is_empty() {
    return Err("Watch-only wallets do not have signing secret material".to_string());
}
```

- [ ] **Step 9: Update crypto commands to supply vault keys**

In `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`, compute a vault key before adding or reading crypto wallet secrets:

```rust
fn crypto_vault_key_from_session(
    session_id: &str,
    state: &State<'_, AppState>,
) -> Result<crate::vault_crypto::VaultKey, String> {
    if let Ok(vault_key) = state.sessions.vault_key(session_id) {
        return Ok(vault_key);
    }
    let master_password = state.sessions.master_password(session_id)?;
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.unlock_vault_key_with_master_password(&master_password)
}
```

Use `crypto_vault_key_from_session` in `add_crypto_wallet` and `get_crypto_wallet_secret`.

- [ ] **Step 10: Run tests**

Run:

```bash
cd /Users/thursday/go/play/mykey/src-tauri
cargo test --test crypto_wallet_storage
cargo test
```

Expected: both commands exit 0.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/vault.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tests/crypto_wallet_storage.rs
git commit -m "feat: persist crypto account metadata safely"
```

---

## Task 5: Add tcx-wasm Smoke Coverage And Error Mapping

**Files:**
- Create: `/Users/thursday/go/play/mykey/scripts/test-tcx-wasm-smoke.mjs`
- Create: `/Users/thursday/go/play/mykey/src-tauri/src/wallet_errors.rs`
- Modify: `/Users/thursday/go/play/mykey/src/utils/tcxWallet.ts`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/lib.rs`
- Modify: `/Users/thursday/go/play/mykey/package.json`

- [ ] **Step 1: Create tcx smoke script**

Create `/Users/thursday/go/play/mykey/scripts/test-tcx-wasm-smoke.mjs`:

```js
import { readFileSync } from 'node:fs'
import init, {
  create_keystore,
  derive_accounts,
  export_mnemonic,
  initSync,
  sign_tx,
} from '@consenlabs/tcx-wasm/tcx_wasm.js'

const wasm = new URL('../node_modules/@consenlabs/tcx-wasm/tcx_wasm_bg.wasm', import.meta.url)
initSync({ module: readFileSync(wasm) })

const password = 'correct horse battery staple'
const prfKey = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const mnemonic = 'inject kidney empty canal shadow pact comfort wife crush horse wife sketch'

const passwordKs = create_keystore(JSON.stringify({ password, mnemonic, network: 'MAINNET' }))
const passkeyKs = create_keystore(JSON.stringify({
  prfKey,
  userId: 'user-1',
  credentialId: 'credential-1',
  rpId: 'mykey.local',
  mnemonic,
  network: 'MAINNET',
}))

const accounts = JSON.parse(derive_accounts(JSON.stringify({
  keystoreJson: passwordKs,
  key: password,
  derivations: [
    { chain: 'ETHEREUM', derivationPath: "m/44'/60'/0'/0/0", chainId: '1', network: 'MAINNET' },
    { chain: 'TRON', derivationPath: "m/44'/195'/0'/0/0", network: 'MAINNET' },
    { chain: 'BITCOIN', derivationPath: "m/84'/0'/0'/0/0", network: 'MAINNET', segWit: 'VERSION_0' },
  ],
})))

if (accounts.length !== 3) throw new Error(`expected 3 accounts, got ${accounts.length}`)
if (!accounts.find((account) => account.chain === 'ETHEREUM')?.address?.startsWith('0x')) throw new Error('missing ETH address')
if (!accounts.find((account) => account.chain === 'TRON')?.address?.startsWith('T')) throw new Error('missing TRON address')
if (!accounts.find((account) => account.chain === 'BITCOIN')?.address?.startsWith('bc1q')) throw new Error('missing BTC native segwit address')

const exported = JSON.parse(export_mnemonic(JSON.stringify({ keystoreJson: passkeyKs, key: prfKey })))
if (exported.mnemonic !== mnemonic) throw new Error('passkey export mnemonic mismatch')

const signed = JSON.parse(sign_tx(JSON.stringify({
  keystoreJson: passwordKs,
  key: password,
  chain: 'ETHEREUM',
  derivationPath: "m/44'/60'/0'/0/0",
  input: {
    nonce: '0',
    gasPrice: '20000000000',
    gasLimit: '21000',
    to: '0x3535353535353535353535353535353535353535',
    value: '1000000000000000',
    chainId: '1',
  },
})))

if (!signed.signature || !signed.txHash) throw new Error('ETH signature or tx hash missing')
console.log(JSON.stringify({ ok: true, accountCount: accounts.length, txHash: signed.txHash }))
```

- [ ] **Step 2: Add script**

Modify `/Users/thursday/go/play/mykey/package.json`:

```json
"test:tcx": "node scripts/test-tcx-wasm-smoke.mjs"
```

- [ ] **Step 3: Add frontend tcx wrapper error mapping**

Modify `/Users/thursday/go/play/mykey/src/utils/tcxWallet.ts`:

```ts
function mapTcxError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  if (/password|decrypt|invalid key/i.test(raw)) return new Error('Wallet unlock failed. Check the password or passkey.')
  if (/mnemonic/i.test(raw)) return new Error('Mnemonic is invalid or unsupported.')
  if (/derivation/i.test(raw)) return new Error('Derivation path is invalid for this chain.')
  return new Error('Wallet operation failed. No secret material was exposed.')
}

async function runTcx<T>(fn: () => T): Promise<T> {
  try {
    await init()
    return fn()
  } catch (error) {
    throw mapTcxError(error)
  }
}
```

Wrap `createTcxKeystore`, `deriveTcxAccounts`, `signTcxTransaction`, and the new `exportTcxMnemonic` with `runTcx`.

- [ ] **Step 4: Add export mnemonic wrapper**

Modify `/Users/thursday/go/play/mykey/src/utils/tcxWallet.ts`:

```ts
import { export_mnemonic } from '@consenlabs/tcx-wasm'

export async function exportTcxMnemonic(input: {
  keystoreJson: string
  unlockSecret: string
}): Promise<string> {
  const result = await runTcx(() => JSON.parse(export_mnemonic(JSON.stringify({
    keystoreJson: input.keystoreJson,
    key: input.unlockSecret,
  }))))
  if (typeof result.mnemonic !== 'string' || !result.mnemonic.trim()) {
    throw new Error('Wallet did not return a mnemonic.')
  }
  return result.mnemonic
}
```

- [ ] **Step 5: Run smoke**

Run:

```bash
npm run test:tcx
```

Expected: command prints JSON with `"ok": true` and exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/test-tcx-wasm-smoke.mjs src/utils/tcxWallet.ts src-tauri/src/wallet_errors.rs src-tauri/src/lib.rs
git commit -m "test: add tcx wasm smoke coverage"
```

---

## Task 6: Complete Wallet Create And Import Flows

**Files:**
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.css`
- Modify: `/Users/thursday/go/play/mykey/src/utils/cryptoPortfolio.ts`
- Modify: `/Users/thursday/go/play/mykey/tests/cryptoPortfolio.test.ts`

- [ ] **Step 1: Add form tests for each import mode**

Extend `/Users/thursday/go/play/mykey/tests/cryptoPortfolio.test.ts`:

```ts
test('wallet forms allow supported create and import modes', () => {
  assert.equal(canSaveCryptoWalletForm({
    name: 'Password wallet',
    walletType: 'tcx-wasm',
    secretKind: 'keystore_json',
    unlockMode: 'password',
    unlockSecret: 'wallet-pass',
    address: '',
  }, false), true)

  assert.equal(canSaveCryptoWalletForm({
    name: 'Passkey wallet',
    walletType: 'tcx-wasm',
    secretKind: 'keystore_json',
    unlockMode: 'passkey-prf',
    unlockSecret: '',
    address: '',
  }, false), true)

  assert.equal(canSaveCryptoWalletForm({
    name: 'Watch',
    walletType: 'hardware-watch',
    secretKind: 'watch_only',
    unlockMode: 'password',
    unlockSecret: '',
    address: '0x3535353535353535353535353535353535353535',
  }, false), true)
})
```

- [ ] **Step 2: Normalize supported wallet types**

Modify `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`:

```ts
const walletTypes = ['tcx-wasm', 'hardware-watch']
const secretKindsByWalletType: Record<string, string[]> = {
  'tcx-wasm': ['keystore_json', 'mnemonic'],
  'hardware-watch': ['watch_only'],
}
```

Remove `private-key` from active choices until raw private key signing is implemented.

- [ ] **Step 3: Store derived public keys**

When calling `add_crypto_wallet`, include:

```ts
publicKey: accounts[0]?.publicKey || null,
extPubKey: accounts[0]?.extPubKey || null,
```

When calling `add_crypto_account`, include the same fields from `deriveTcxAccounts`.

- [ ] **Step 4: Derive ETH/TRON/BTC by default after create**

For new password/passkey wallets, call:

```ts
const defaultDerivations = ['ETHEREUM', 'TRON', 'BITCOIN'].map((chain) =>
  buildDerivation(chain, walletForm.network, defaultDerivationPathByChain[chain])
)
```

Use the first derived account in `add_crypto_wallet`, then call `add_crypto_account` for the remaining derived accounts.

- [ ] **Step 5: Keep mnemonic/keystore plaintext out of state after save**

Immediately after successful save:

```ts
setWalletForm((prev) => ({
  ...prev,
  name: '',
  unlockSecret: '',
  secretMaterial: '',
  address: '',
}))
setWalletUnlockSecret('')
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:linkage
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/CryptoWalletManager.tsx src/components/CryptoWalletManager.css src/utils/cryptoPortfolio.ts tests/cryptoPortfolio.test.ts
git commit -m "feat: complete wallet create and import flows"
```

---

## Task 7: Add RPC Configuration Management

**Files:**
- Create: `/Users/thursday/go/play/mykey/src/utils/cryptoRpc.ts`
- Create: `/Users/thursday/go/play/mykey/tests/cryptoRpc.test.ts`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`

- [ ] **Step 1: Add TS tests for provider normalization**

Create `/Users/thursday/go/play/mykey/tests/cryptoRpc.test.ts`:

```ts
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { normalizeCryptoRpcProvider } from '../src/utils/cryptoRpc'

test('normalizeCryptoRpcProvider validates chain provider secrets', () => {
  assert.deepEqual(normalizeCryptoRpcProvider({
    chain: 'ethereum',
    network: 'sepolia',
    provider: 'alchemy',
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/demo',
    apiKey: 'secret',
  }), {
    chain: 'ETHEREUM',
    network: 'SEPOLIA',
    provider: 'alchemy',
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/demo',
    apiKey: 'secret',
  })

  assert.throws(() => normalizeCryptoRpcProvider({
    chain: '',
    network: 'mainnet',
    provider: 'alchemy',
    rpcUrl: 'ftp://invalid',
    apiKey: '',
  }), /Chain is required/)
})
```

- [ ] **Step 2: Add helper implementation**

Create `/Users/thursday/go/play/mykey/src/utils/cryptoRpc.ts`:

```ts
export type CryptoRpcProviderInput = {
  chain: string
  network: string
  provider: string
  rpcUrl: string
  apiKey?: string
}

export function normalizeCryptoRpcProvider(input: CryptoRpcProviderInput): Required<CryptoRpcProviderInput> {
  const chain = input.chain.trim().toUpperCase()
  const network = input.network.trim().toUpperCase()
  const provider = input.provider.trim()
  const rpcUrl = input.rpcUrl.trim()
  const apiKey = (input.apiKey || '').trim()
  if (!chain) throw new Error('Chain is required')
  if (!network) throw new Error('Network is required')
  if (!provider) throw new Error('Provider is required')
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('RPC URL must start with http:// or https://')
  return { chain, network, provider, rpcUrl, apiKey }
}
```

- [ ] **Step 3: Add DB table for RPC providers**

In `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs` migration:

```sql
CREATE TABLE IF NOT EXISTS crypto_rpc_providers (
    id TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    network TEXT NOT NULL,
    provider TEXT NOT NULL,
    rpc_url TEXT NOT NULL,
    api_secret_key_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(chain, network, provider)
);
```

- [ ] **Step 4: Add commands**

Add to `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn upsert_crypto_rpc_provider(
    chain: String,
    network: String,
    provider: String,
    rpc_url: String,
    api_key: Option<String>,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let master_password = master_password_from_session(&session_id, &state)?;
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Session is locked or expired".to_string());
    }
    vault.upsert_crypto_rpc_provider(chain, network, provider, rpc_url, api_key)?;
    Ok(true)
}
```

Also add `get_crypto_rpc_providers` and `delete_crypto_rpc_provider` with the same session validation.

- [ ] **Step 5: Remove localStorage for Alchemy and OKLink keys**

In `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`, replace localStorage initialization with values loaded from `get_crypto_rpc_providers`.

Remove these persistent key writes:

```ts
window.localStorage.setItem(alchemyApiKeyStorageKey, key)
window.localStorage.setItem(oklinkApiKeyStorageKey, key)
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:linkage
cd src-tauri && cargo test
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/utils/cryptoRpc.ts tests/cryptoRpc.test.ts src-tauri/src/vault.rs src-tauri/src/commands.rs src/components/CryptoWalletManager.tsx tsconfig.tests.json
git commit -m "feat: store crypto rpc provider config in vault"
```

---

## Task 8: Implement ETH/ERC20/TRON/BTC Balance Services

**Files:**
- Create: `/Users/thursday/go/play/mykey/src-tauri/src/crypto_rpc.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`
- Modify: `/Users/thursday/go/play/mykey/tests/assetVault.test.ts`

- [ ] **Step 1: Move EVM RPC helpers to `crypto_rpc.rs`**

Create `/Users/thursday/go/play/mykey/src-tauri/src/crypto_rpc.rs` with:

```rust
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

pub async fn call_evm_rpc(rpc_url: &str, method: &str, params: Value) -> Result<Value, String> {
    let rpc_url = rpc_url.trim();
    if !(rpc_url.starts_with("https://") || rpc_url.starts_with("http://")) {
        return Err("RPC URL must start with http:// or https://".to_string());
    }
    let response = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .post(rpc_url)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("RPC HTTP error {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("Invalid RPC response: {e}"))
}
```

- [ ] **Step 2: Add TRON balance command**

In `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`, add `query_crypto_tron_balance` using OKLink when configured:

```rust
#[tauri::command]
pub async fn query_crypto_tron_balance(
    api_key: String,
    owner_address: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<OklinkDiscoveredToken>, String> {
    master_password_from_session(&session_id, &state)?;
    discover_oklink_address_assets(api_key, "TRON".to_string(), owner_address, session_id, state).await
}
```

- [ ] **Step 3: Add BTC balance command**

Add:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcBalanceResult {
    pub address: String,
    pub confirmed_sats: u64,
    pub mempool_sats: u64,
}

#[tauri::command]
pub async fn query_crypto_btc_balance(
    explorer_base_url: String,
    address: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<BtcBalanceResult, String> {
    master_password_from_session(&session_id, &state)?;
    let base = explorer_base_url.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("BTC explorer URL must start with http:// or https://".to_string());
    }
    if !(address.starts_with("bc1q") || address.starts_with("tb1q")) {
        return Err("BTC Native SegWit address must start with bc1q or tb1q".to_string());
    }
    let url = format!("{base}/api/address/{address}");
    let value: serde_json::Value = reqwest::get(url).await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let chain_stats = value.get("chain_stats").ok_or_else(|| "BTC response missing chain_stats".to_string())?;
    let mempool_stats = value.get("mempool_stats").ok_or_else(|| "BTC response missing mempool_stats".to_string())?;
    let funded = chain_stats.get("funded_txo_sum").and_then(Value::as_u64).unwrap_or(0);
    let spent = chain_stats.get("spent_txo_sum").and_then(Value::as_u64).unwrap_or(0);
    let mempool_funded = mempool_stats.get("funded_txo_sum").and_then(Value::as_u64).unwrap_or(0);
    let mempool_spent = mempool_stats.get("spent_txo_sum").and_then(Value::as_u64).unwrap_or(0);
    Ok(BtcBalanceResult {
        address,
        confirmed_sats: funded.saturating_sub(spent),
        mempool_sats: mempool_funded.saturating_sub(mempool_spent),
    })
}
```

- [ ] **Step 4: Persist balance refresh status**

Add columns to `crypto_tokens`:

```rust
Self::ensure_column(conn, "crypto_tokens", "refresh_status", "TEXT")?;
Self::ensure_column(conn, "crypto_tokens", "refresh_error", "TEXT")?;
```

Extend `CryptoToken` with `refresh_status` and `refresh_error`.

- [ ] **Step 5: Update UI refresh per chain**

In `handleQueryBalance`, route by `account.chain`:

```ts
if (account.chain === 'BITCOIN') {
  return invoke('query_crypto_btc_balance', { explorerBaseUrl: btcExplorerUrl, address: account.address, sessionId })
}
if (account.chain === 'TRON') {
  return invoke('query_crypto_tron_balance', { apiKey: oklinkApiKey, ownerAddress: account.address, sessionId })
}
return invoke('query_crypto_native_balance', { rpcUrl: rpcForm.rpcUrl, address: account.address, sessionId })
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd src-tauri && cargo test
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/crypto_rpc.rs src-tauri/src/commands.rs src-tauri/src/vault.rs src-tauri/src/lib.rs src/components/CryptoWalletManager.tsx tests/assetVault.test.ts
git commit -m "feat: add multi-chain balance refresh"
```

---

## Task 9: Complete EVM Transaction Flow

**Files:**
- Create: `/Users/thursday/go/play/mykey/src/utils/walletValidation.ts`
- Create: `/Users/thursday/go/play/mykey/tests/walletValidation.test.ts`
- Modify: `/Users/thursday/go/play/mykey/src/utils/assetVault.ts`
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`

- [ ] **Step 1: Add send validation tests**

Create `/Users/thursday/go/play/mykey/tests/walletValidation.test.ts`:

```ts
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { validateEvmSendForm } from '../src/utils/walletValidation'

test('validateEvmSendForm accepts native EIP-1559 transfer', () => {
  assert.equal(validateEvmSendForm({
    assetMode: 'native',
    tokenContract: '',
    tokenDecimals: '18',
    to: '0x3535353535353535353535353535353535353535',
    valueEth: '0.01',
    nonce: '1',
    gasLimit: '21000',
    chainId: '11155111',
    maxFeePerGas: '30000000000',
    maxPriorityFeePerGas: '1000000000',
    gasPrice: '',
  }).ok, true)
})

test('validateEvmSendForm rejects missing token contract for erc20', () => {
  assert.equal(validateEvmSendForm({
    assetMode: 'erc20',
    tokenContract: '',
    tokenDecimals: '6',
    to: '0x3535353535353535353535353535353535353535',
    valueEth: '1',
    nonce: '1',
    gasLimit: '65000',
    chainId: '11155111',
    maxFeePerGas: '',
    maxPriorityFeePerGas: '',
    gasPrice: '20000000000',
  }).ok, false)
})
```

- [ ] **Step 2: Implement validation helper**

Create `/Users/thursday/go/play/mykey/src/utils/walletValidation.ts`:

```ts
import { normalizeEvmAddress, tokenToBaseUnitDecimal } from './assetVault'

export type EvmSendForm = {
  assetMode: string
  tokenContract: string
  tokenDecimals: string
  to: string
  valueEth: string
  nonce: string
  gasLimit: string
  chainId: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  gasPrice: string
}

export function validateEvmSendForm(form: EvmSendForm): { ok: boolean; error?: string } {
  try {
    normalizeEvmAddress(form.to)
    tokenToBaseUnitDecimal(form.valueEth, form.assetMode === 'erc20' ? Number(form.tokenDecimals || '18') : 18)
    if (form.assetMode === 'erc20') normalizeEvmAddress(form.tokenContract)
    if (!/^\d+$/.test(form.nonce.trim())) return { ok: false, error: 'Nonce must be a non-negative integer.' }
    if (!/^\d+$/.test(form.gasLimit.trim())) return { ok: false, error: 'Gas limit must be a non-negative integer.' }
    if (!/^\d+$/.test(form.chainId.trim())) return { ok: false, error: 'Chain ID must be a non-negative integer.' }
    if (!form.gasPrice.trim() && (!form.maxFeePerGas.trim() || !form.maxPriorityFeePerGas.trim())) {
      return { ok: false, error: 'Enter legacy gas price or EIP-1559 fee values.' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
```

- [ ] **Step 3: Add transaction table**

In `/Users/thursday/go/play/mykey/src-tauri/src/vault.rs` migration:

```sql
CREATE TABLE IF NOT EXISTS crypto_transactions (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    chain TEXT NOT NULL,
    network TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_tx TEXT,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(chain, network, tx_hash)
);
```

- [ ] **Step 4: Save transaction after broadcast**

Add command:

```rust
#[tauri::command]
pub fn save_crypto_transaction(
    wallet_id: String,
    account_id: String,
    chain: String,
    network: String,
    tx_hash: String,
    raw_tx: Option<String>,
    summary_json: serde_json::Value,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    master_password_from_session(&session_id, &state)?;
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.save_crypto_transaction(wallet_id, account_id, chain, network, tx_hash, "submitted".to_string(), raw_tx, summary_json)?;
    Ok(true)
}
```

- [ ] **Step 5: Add status refresh command**

Add:

```rust
#[tauri::command]
pub async fn get_evm_transaction_status(
    rpc_url: String,
    tx_hash: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    master_password_from_session(&session_id, &state)?;
    let response = crate::crypto_rpc::call_evm_rpc(&rpc_url, "eth_getTransactionReceipt", json!([tx_hash])).await?;
    match response.get("result") {
        Some(Value::Null) | None => Ok("pending".to_string()),
        Some(receipt) => match receipt.get("status").and_then(Value::as_str) {
            Some("0x1") => Ok("confirmed".to_string()),
            Some("0x0") => Ok("failed".to_string()),
            _ => Ok("confirmed".to_string()),
        },
    }
}
```

- [ ] **Step 6: Wire home Send button to the Advanced send form**

In `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`, change:

```tsx
<button className="crypto-action" disabled={!activeAccountCanSign}>Send</button>
```

to:

```tsx
<button
  className="crypto-action"
  disabled={!activeAccountCanSign}
  onClick={() => setCryptoMode('advanced')}
>
  Send
</button>
```

- [ ] **Step 7: Add risk labels in confirmation modal**

Add computed risk:

```ts
const txRisk = sendForm.assetMode === 'erc20'
  ? 'ERC20 transfer. Verify token contract and recipient.'
  : pendingTxInput?.data
    ? 'Contract call. Verify destination, calldata, and fees.'
    : 'Native transfer. Verify recipient and amount.'
```

Render it above the JSON payload.

- [ ] **Step 8: Run tests**

Run:

```bash
npm run test:linkage
npm run build
cd src-tauri && cargo test
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/utils/walletValidation.ts tests/walletValidation.test.ts src/utils/assetVault.ts src/components/CryptoWalletManager.tsx src-tauri/src/vault.rs src-tauri/src/commands.rs
git commit -m "feat: complete evm transaction flow"
```

---

## Task 10: Add Controlled Mnemonic Export And Recovery Flow

**Files:**
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`
- Modify: `/Users/thursday/go/play/mykey/src/utils/tcxWallet.ts`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`

- [ ] **Step 1: Add export unlock flow state**

In `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`, add:

```ts
const [exportModalOpen, setExportModalOpen] = useState(false)
const [exportConfirmText, setExportConfirmText] = useState('')
const [exportedMnemonic, setExportedMnemonic] = useState('')
```

- [ ] **Step 2: Require explicit confirmation text**

Enable export only when:

```ts
const canExportMnemonic = exportConfirmText.trim() === 'I understand the recovery risk'
```

- [ ] **Step 3: Implement export handler**

Add:

```ts
const handleExportMnemonic = async () => {
  if (!selectedWallet) return
  if (!canExportMnemonic) {
    onError('Type the confirmation phrase before exporting.')
    return
  }
  let unlockSecret = walletUnlockSecret
  if (!unlockSecret && selectedWalletUsesPasskey) {
    if (!selectedWallet.passkeyCredentialId || !selectedWallet.passkeyPrfSalt) throw new Error('Wallet is missing passkey metadata.')
    unlockSecret = await getPasskeyPrfKey(selectedWallet.passkeyCredentialId, selectedWallet.passkeyPrfSalt, selectedWallet.passkeyRpId)
  }
  const keystoreJson = await invoke<string>('get_crypto_wallet_secret', { id: selectedWallet.id, sessionId })
  const mnemonic = await exportTcxMnemonic({ keystoreJson, unlockSecret })
  setExportedMnemonic(mnemonic)
}
```

- [ ] **Step 4: Clear exported plaintext on close**

On modal close:

```ts
setExportedMnemonic('')
setExportConfirmText('')
setExportModalOpen(false)
```

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/CryptoWalletManager.tsx src/utils/tcxWallet.ts src-tauri/src/commands.rs
git commit -m "feat: add controlled mnemonic export flow"
```

---

## Task 11: Finish UI States And Responsive Wallet UX

**Files:**
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.css`
- Modify: `/Users/thursday/go/play/mykey/design.md`

- [ ] **Step 1: Add complete empty/loading/error states**

Ensure these messages are rendered:

```tsx
const walletEmptyState = (
  <div className="crypto-empty-state">
    <strong>No crypto wallet yet</strong>
    <span>Create, import, or watch an address to begin.</span>
  </div>
)
```

Use chain-specific loading labels:

```ts
const balanceActionLabel = queryingBalance === account.id ? 'Refreshing' : 'Balance'
```

- [ ] **Step 2: Add Receive flow**

Change the home Receive button to:

```tsx
<button className="crypto-action" disabled={!primaryAccount} onClick={() => setReceiveModalOpen(true)}>
  Receive
</button>
```

Render modal with address and copy button:

```tsx
<code>{primaryAccount?.address}</code>
<button className="crypto-action primary" onClick={() => primaryAccount && navigator.clipboard.writeText(primaryAccount.address)}>
  Copy Address
</button>
```

- [ ] **Step 3: Hide inactive feature tabs from production view**

Remove active tabs for NFTs, predictions, leverage, and activity from the wallet main view. Keep the data model unaffected. This avoids presenting unfinished surfaces as product capability.

- [ ] **Step 4: Add responsive CSS constraints**

Add to `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.css`:

```css
.crypto-confirm-modal,
.crypto-account-drawer {
  max-width: min(680px, calc(100vw - 24px));
}

.crypto-account-row code,
.crypto-confirm-grid code,
.crypto-tx-hash {
  overflow-wrap: anywhere;
}

.crypto-action,
.crypto-mini-action {
  min-height: 40px;
  white-space: normal;
}
```

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/CryptoWalletManager.tsx src/components/CryptoWalletManager.css design.md
git commit -m "feat: finish crypto wallet ui states"
```

---

## Task 12: Migrate Crypto Commands From Master Password To Session ID

**Files:**
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`
- Modify: `/Users/thursday/go/play/mykey/src/components/CryptoWalletManager.tsx`
- Modify: `/Users/thursday/go/play/mykey/src/App.tsx`

- [ ] **Step 1: Change crypto command parameters**

For these commands, replace `master_password: String` with `session_id: String`:

```rust
add_crypto_wallet
get_crypto_wallets
get_crypto_wallet_secret
add_crypto_account
add_crypto_token
update_crypto_token_balance
delete_crypto_wallet
query_crypto_native_balance
get_crypto_evm_fee_defaults
query_crypto_erc20_balance
discover_alchemy_erc20_tokens
discover_oklink_address_assets
broadcast_crypto_raw_transaction
```

At the start of each command:

```rust
state.sessions.validate(&session_id)?;
```

- For `add_crypto_wallet` and `get_crypto_wallet_secret`, also call:

```rust
let vault_key = crypto_vault_key_from_session(&session_id, &state)?;
```

- For non-secret metadata commands, session validation is sufficient after the session exists.

- [ ] **Step 2: Update React props**

Change `CryptoWalletManagerProps`:

```ts
interface CryptoWalletManagerProps {
  sessionId: string
  wallets: CryptoWallet[]
  loading: boolean
  onWalletsChanged: (wallets: CryptoWallet[]) => void
  onRefresh: () => Promise<void>
  onError: (message: string) => void
}
```

Replace all `{ masterPassword }` invoke payloads in `CryptoWalletManager.tsx` with `{ sessionId }`.

- [ ] **Step 3: Update wallet loading in `App.tsx`**

Replace:

```ts
invoke<CryptoWallet[]>('get_crypto_wallets', { masterPassword })
```

with:

```ts
invoke<CryptoWallet[]>('get_crypto_wallets', { sessionId })
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test:linkage
npm run build
cd src-tauri && cargo test
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src/components/CryptoWalletManager.tsx src/App.tsx
git commit -m "refactor: use sessions for crypto wallet commands"
```

---

## Task 13: Add Retry Limits And Memory Clearing

**Files:**
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/auth_session.rs`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/src/commands.rs`
- Modify: `/Users/thursday/go/play/mykey/src/App.tsx`
- Modify: `/Users/thursday/go/play/mykey/src-tauri/tests/auth_session.rs`

- [ ] **Step 1: Test failed authentication lockout**

Extend `/Users/thursday/go/play/mykey/src-tauri/tests/auth_session.rs`:

```rust
#[test]
fn failed_attempts_lock_until_cooldown() {
    let store = AuthSessionStore::new(Duration::from_secs(60));
    assert!(store.record_failed_attempt().is_ok());
    assert!(store.record_failed_attempt().is_ok());
    assert!(store.record_failed_attempt().is_ok());
    assert!(store.ensure_login_allowed().is_err());
}
```

- [ ] **Step 2: Implement attempt counters**

Add to `AuthSessionStore`:

```rust
failed_attempts: Mutex<Vec<DateTime<Utc>>>,
```

Add methods:

```rust
pub fn ensure_login_allowed(&self) -> Result<(), String> {
    let cutoff = Utc::now() - ChronoDuration::minutes(5);
    let mut attempts = self.failed_attempts.lock().map_err(|e| e.to_string())?;
    attempts.retain(|time| *time > cutoff);
    if attempts.len() >= 3 {
        return Err("Too many failed attempts. Try again in a few minutes.".to_string());
    }
    Ok(())
}

pub fn record_failed_attempt(&self) -> Result<(), String> {
    self.failed_attempts.lock().map_err(|e| e.to_string())?.push(Utc::now());
    Ok(())
}

pub fn clear_failed_attempts(&self) {
    if let Ok(mut attempts) = self.failed_attempts.lock() {
        attempts.clear();
    }
}
```

- [ ] **Step 3: Wire lockout into auth commands**

In `authenticate_session`:

```rust
state.sessions.ensure_login_allowed()?;
if !vault.authenticate(&password) {
    state.sessions.record_failed_attempt()?;
    return Err("Invalid master password".to_string());
}
state.sessions.clear_failed_attempts();
```

- [ ] **Step 4: Add explicit lock button**

In `/Users/thursday/go/play/mykey/src/App.tsx`, add header action:

```tsx
<button className="btn btn-secondary" onClick={handleLock}>
  Lock
</button>
```

`handleLock`:

```ts
const handleLock = async () => {
  if (sessionId) await lockSession(sessionId)
  setAuthSession(null)
  setIsAuthenticated(false)
  setCryptoWallets([])
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd src-tauri && cargo test --test auth_session
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/auth_session.rs src-tauri/src/commands.rs src-tauri/tests/auth_session.rs src/App.tsx
git commit -m "feat: add lockout and session clearing"
```

---

## Task 14: Documentation

**Files:**
- Create: `/Users/thursday/go/play/mykey/docs/crypto-wallet.md`
- Create: `/Users/thursday/go/play/mykey/docs/passkey-prf-compatibility.md`
- Create: `/Users/thursday/go/play/mykey/docs/crypto-wallet-security.md`
- Modify: `/Users/thursday/go/play/mykey/README.md`
- Modify: `/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md`

- [ ] **Step 1: Write usage guide**

Create `/Users/thursday/go/play/mykey/docs/crypto-wallet.md`:

```markdown
# Crypto Wallet 使用说明

MyKey 支持创建 password 钱包、创建 passkey PRF 钱包、导入 mnemonic、导入 tcx keystore JSON、导入 watch-only 地址。

## 创建钱包

打开 Crypto -> Create / Import，选择 `tcx-wasm`，选择 `password` 或 `passkey-prf`。创建后 MyKey 会派生 ETH、TRON、BTC Native SegWit 默认地址。

## 查询余额

EVM 链使用配置的 RPC。TRON 和 BTC 使用配置的 explorer provider。余额刷新失败时，Token 行会显示失败状态和最近更新时间。

## 发送交易

ETH 和 ERC20 发送在 Crypto -> Advanced -> RPC & Send 中完成。发送前必须确认收款地址、金额、gas、nonce、chainId 和风险提示。
```

- [ ] **Step 2: Write passkey PRF compatibility doc**

Create `/Users/thursday/go/play/mykey/docs/passkey-prf-compatibility.md`:

```markdown
# Passkey PRF 兼容性说明

Passkey PRF 依赖 WebAuthn PRF extension。MyKey 会在当前 Tauri WebView 中检测 WebAuthn、Web Crypto 和 PRF 返回结果。

如果当前环境不支持 PRF，MyKey 会显示 password wallet fallback。已有 passkey 钱包仍需要支持 PRF 的环境才能用 passkey 派生地址或签名。
```

- [ ] **Step 3: Write security doc**

Create `/Users/thursday/go/play/mykey/docs/crypto-wallet-security.md`:

```markdown
# Crypto Wallet 安全说明

MyKey 是本地优先应用。钱包 secret 只保存在本机 vault/secret store 中。不要把 mnemonic、private key、tcx keystore JSON、passkey PRF 输出或 RPC API key 发给任何人。

导出 mnemonic 只用于备份和恢复。导出前请确认当前设备安全，导出后立即离线保存并关闭导出窗口。

Watch-only 钱包只保存公开地址，不能签名，适合观察余额和测试 portfolio。
```

- [ ] **Step 4: Link docs from README**

Add to `/Users/thursday/go/play/mykey/README.md`:

```markdown
## Crypto Wallet

- [Crypto Wallet 使用说明](./docs/crypto-wallet.md)
- [Passkey PRF 兼容性说明](./docs/passkey-prf-compatibility.md)
- [Crypto Wallet 安全说明](./docs/crypto-wallet-security.md)
```

- [ ] **Step 5: Commit**

```bash
git add README.md Docs_code/Mykey\ 产品文档.md docs/crypto-wallet.md docs/passkey-prf-compatibility.md docs/crypto-wallet-security.md
git commit -m "docs: add crypto wallet user and security guides"
```

---

## Task 15: Full Verification And Packaging

**Files:**
- Modify: `/Users/thursday/go/play/mykey/Docs_code/crypto-wallet-release-checklist.md`

- [ ] **Step 1: Run all automated checks**

Run:

```bash
cd /Users/thursday/go/play/mykey
npm run test:linkage
npm run test:gateway
npm run test:tcx
npm run build
cd src-tauri
cargo test
cd ..
npm run tauri:build:dmg
```

Expected: every command exits 0. If any command fails, stop and fix before packaging.

- [ ] **Step 2: Inspect artifacts**

Run:

```bash
find /Users/thursday/go/play/mykey/src-tauri/target/release/bundle -maxdepth 4 \( -name '*.app' -o -name '*.dmg' \) -print
stat -f '%Sm %N' /Users/thursday/go/play/mykey/src-tauri/target/release/bundle/macos/MyKey.app
find /Users/thursday/go/play/mykey/src-tauri/target/release/bundle/dmg -name '*.dmg' -maxdepth 1 -print
```

Expected: fresh `.app` and `.dmg` timestamps after this task starts. Universal DMG is required for final delivery.

- [ ] **Step 3: Complete manual E2E checklist**

Open `/Users/thursday/go/play/mykey/Docs_code/crypto-wallet-release-checklist.md` and mark every manual item based on actual Tauri app testing.

- [ ] **Step 4: Record limitations**

Add this section to `/Users/thursday/go/play/mykey/Docs_code/crypto-wallet-release-checklist.md` with actual results:

```markdown
## Final Limitations

- Cosmos, Solana, and Polkadot are not enabled for signing in this release.
- BTC sending is not exposed unless BTC UTXO construction and broadcast pass manual test.
- TRON signing is not exposed unless TRON transaction construction and broadcast pass manual test.
```

Remove a limitation only when the matching manual E2E item passes.

- [ ] **Step 5: Commit**

```bash
git add Docs_code/crypto-wallet-release-checklist.md
git commit -m "chore: record crypto wallet release verification"
```

---

## Task 16: Final Review And Delivery Summary

**Files:**
- No required code files.

- [ ] **Step 1: Check git status**

Run:

```bash
git status --short
```

Expected: clean working tree after commits, or only intentionally uncommitted local artifacts.

- [ ] **Step 2: Summarize completed capabilities**

Prepare final delivery text with:

```markdown
## Completed

- AI Token/API Key and Crypto Wallet inventory are both available in MyKey.
- Password and passkey PRF wallet unlock paths are implemented.
- Wallet create/import/watch-only flows are implemented.
- ETH/TRON/BTC Native SegWit account derivation is implemented.
- ETH/ERC20/TRON/BTC balance refresh is implemented.
- EVM ETH/ERC20 send flow is implemented.
- Lock, retry limits, safe export, docs, and verification are complete.

## Verified

- npm run test:linkage: pass
- npm run test:gateway: pass
- npm run test:tcx: pass
- cargo test: pass
- npm run build: pass
- npm run tauri:build:dmg: pass

## Artifacts

- App:
- DMG:

## Limitations

- Copy exact limitations from `Docs_code/crypto-wallet-release-checklist.md`.
```

- [ ] **Step 3: Create PR or hand off local branch**

If the user wants a PR, use the GitHub workflow after verification:

```bash
git status --short
git log --oneline -5
```

Then push and open a draft PR.

---

## Coverage Review

- Plan item 1 is covered by Tasks 1, 14, 16.
- Plan item 2 is covered by Tasks 2, 3, 4, 7, 12, 13.
- Plan item 3 is covered by Task 5 and Task 10.
- Plan item 4 is covered by Task 6.
- Plan item 5 is covered by Tasks 4, 5, 6.
- Plan item 6 is covered by Tasks 7 and 8.
- Plan item 7 is covered by Task 9.
- Plan item 8 is covered by Tasks 3, 5, 15.
- Plan item 9 is covered by Tasks 6, 9, 10, 11.
- Plan item 10 is covered by Tasks 1, 5, 15.
- Plan item 11 is covered by Task 14.
- Plan item 12 is covered by Tasks 15 and 16.
