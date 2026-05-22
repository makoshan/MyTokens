---
name: mykey
description: >
  Use this skill to drive the MyKey vault from the command line — the 密钥库
  (secret/credential store), crypto wallet creation/import, and API-key retrieval.
  Activate when the user wants to add/list/get/delete API credentials, create or
  import a crypto wallet (mnemonic / keystore / watch-only), read or set wallet
  data-provider keys (Alchemy/OKLink), inspect AI provider configs, or fetch
  compute-gateway access credentials — without opening the desktop app. Triggers
  on: "mykey cli", "密钥库", "vault", "secret store", "create a wallet",
  "import wallet", "钱包", "api key", "gateway creds".
---

# mykey

`mykey` is a headless CLI over the same encrypted SQLite vault (`vault.db`) the
MyKey desktop app uses. It reuses the app's Rust `Vault` directly, so secrets are
read/written with the same at-rest AES‑256‑GCM encryption, and wallet keystores
are generated with the same `@consenlabs/tcx-wasm` engine the GUI uses — so a
wallet created via the CLI can be unlocked and signed by the GUI.

> **Install**: copy this folder to `~/.claude/skills/mykey/` so Claude Code can
> discover it.

## Binary & build

- Source: `src-tauri/src/bin/mykey.rs` (the `mykey` repo).
- Build: `cd src-tauri && cargo build --features cli-tools --bin mykey`
  (binary at `src-tauri/target/debug/mykey`; symlink it onto your `PATH`, e.g.
  `~/.local/bin/mykey`).
- The default Tauri app build is unaffected — the CLI deps are gated behind the
  `cli-tools` Cargo feature.

## Master password (never on argv)

Every read/write authenticates the vault. Resolution order:
1. `MYKEY_MASTER_PASSWORD` env var (use for scripting/automation).
2. Interactive hidden prompt (`rpassword`) when run in a terminal.

```bash
export MYKEY_MASTER_PASSWORD='…'          # or omit and let it prompt
```

## Environment

| Var | Purpose |
|---|---|
| `MYKEY_MASTER_PASSWORD` | Master password (else prompt). |
| `MYKEY_VAULT_DB` | Full path to an alternate `vault.db` (else `--db`, else the desktop app default). Use a throwaway path for testing. |
| `MYKEY_TCX_SIDECAR` | Path to `scripts/tcx-keygen.mjs` (the tcx-wasm keygen helper). Needed for `wallet create`/`import --mnemonic`. Defaults to `scripts/tcx-keygen.mjs` relative to the cwd. |
| `MYKEY_WALLET_UNLOCK_SECRET` | Per-wallet keystore unlock secret for `wallet create`/`import` (else `--unlock-secret`, else prompt). Independent of the master password, matching the GUI. |

Global flags: `--json` (machine-readable output), `--db <path>` (override vault path).

## Commands

```bash
# Vault lifecycle
mykey vault status                 # is it initialized? unlock methods?
mykey vault init --recovery        # set master password (first run) + print a one-time recovery key

# 密钥库 (API credentials)
mykey secret list [--reveal]       # keys masked unless --reveal
mykey secret add --provider openai --name "prod" --key sk-... [--source manual]
mykey secret add --provider openai --name "prod"          # omit --key: reads from stdin pipe or hidden prompt
mykey secret get <id> [--reveal]
mykey secret rm <id>

# Crypto wallets
mykey wallet create --name "main" [--chain ETHEREUM] [--network MAINNET] [--unlock-secret S]   # random mnemonic → tcx keystore
mykey wallet import --name "imp" --mnemonic "word1 ... word12"        # import from mnemonic
mykey wallet import --name "imp" --keystore ./keystore.json           # import existing tcx keystore
mykey wallet watch  --name "vitalik" --address 0x... [--chain ETHEREUM]   # watch-only, no secret
mykey wallet list
mykey wallet export <id> [--reveal]    # stored keystore/secret material
mykey wallet rm <id>

# API keys
mykey apikey wallet get                          # Alchemy/OKLink, shows source (.env vs vault)
mykey apikey wallet set alchemy <key>            # also: oklink
mykey apikey providers                           # configured AI providers

# Compute gateway
mykey gateway creds <app_type>                   # e.g. claude_code, codex
```

## Important notes

- **GUI cache staleness**: if the desktop app is *running*, it serves credential
  and provider reads from an in-memory cache loaded at startup. CLI writes land on
  disk immediately (WAL, safe to coexist) but won't appear in the running GUI until
  it's restarted. Crypto wallets and secret *values* are read fresh from the DB.
- **Wallet keystore unlock secret** is separate from the master password (the GUI
  works the same way). Remember it — it's what unlocks the keystore for signing.
- `wallet create`/`import --mnemonic` require Node + the repo's `node_modules`
  (for `@consenlabs/tcx-wasm`); run from the repo or set `MYKEY_TCX_SIDECAR`.
- Verified: importing the test mnemonic `abandon abandon … about` yields the
  canonical address `0x9858EfFD232B4033E47d90003D41EC34EcaEda94`, and re-deriving
  from the stored keystore reproduces it — confirming GUI-signable compatibility.

## Example: scripted bootstrap

```bash
export MYKEY_MASTER_PASSWORD='strong-pass'
export MYKEY_VAULT_DB=/tmp/demo/vault.db
export MYKEY_TCX_SIDECAR="$PWD/scripts/tcx-keygen.mjs"
export MYKEY_WALLET_UNLOCK_SECRET='wallet-secret'

mykey vault init --recovery
mykey secret add --provider anthropic --name claude --key sk-ant-...
mykey apikey wallet set alchemy alch_...
mykey wallet create --name "main eth"
mykey --json wallet list
```
