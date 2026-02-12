use crate::{
    provider_defaults, secret_store::Secret, secret_store::SecretManager,
    secret_store::SecretMetadata, secret_store::SecretStoreConfig, usage::CostUsage,
    usage::UsageQuota, usage::UsageSnapshot, AppIntegration, AppRoute, Credential,
    ExternalLibraryMcp, ExternalLibrarySkill, GatewayAccessCredentials, GatewayPolicySettings,
    GatewayRequestLog, GlobalSettingsPayload, IntegrationConfigSnapshot, OpencodeConfigSnapshot,
    PromptTemplate, ProviderAppBinding, ProviderConfig, ProviderEndpoint, ProviderEnvVar,
    ProviderModel, ServiceConfig,
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::Local;
use rand::rngs::OsRng;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub struct Vault {
    conn: Connection,
    db_path: PathBuf,
    master_password_hash: Option<String>,
    credentials: HashMap<String, Credential>,
    providers: HashMap<String, ProviderConfig>,
    prompts: HashMap<String, PromptTemplate>,
    provider_endpoints: HashMap<String, Vec<ProviderEndpoint>>,
    provider_models: HashMap<String, Vec<ProviderModel>>,
    provider_env_vars: HashMap<String, Vec<ProviderEnvVar>>,
    provider_app_bindings: HashMap<String, Vec<ProviderAppBinding>>,
    secret_manager: SecretManager,
}

#[derive(Debug, Clone)]
pub struct GatewayResolvedRoute {
    pub app_type: String,
    pub provider: String,
    pub model: Option<String>,
    pub upstream_api_key: String,
    pub upstream_base_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GatewayRequestLogInput {
    pub app_type: String,
    pub provider: String,
    pub model: Option<String>,
    pub endpoint: String,
    pub status_code: i64,
    pub latency_ms: i64,
    pub blocked_reason: Option<String>,
    pub error_code: Option<String>,
    pub estimated_cost_usd: Option<f64>,
}

impl Vault {
    pub fn new() -> Self {
        let (conn, db_path) = Self::open_db().unwrap_or_else(|err| panic!("DB init failed: {err}"));
        Self::migrate(&conn).unwrap_or_else(|err| panic!("DB migrate failed: {err}"));

        let master_password_hash = Self::load_master_password(&conn).unwrap_or(None);
        let credentials = Self::load_credentials(&conn).unwrap_or_default();
        let providers = Self::load_providers(&conn).unwrap_or_default();
        let prompts = Self::load_prompts(&conn).unwrap_or_default();
        let provider_endpoints = Self::load_provider_endpoints(&conn).unwrap_or_default();
        let provider_models = Self::load_provider_models(&conn).unwrap_or_default();
        let provider_env_vars = Self::load_provider_env_vars(&conn).unwrap_or_default();
        let provider_app_bindings = Self::load_provider_app_bindings(&conn).unwrap_or_default();
        let secret_manager = Self::init_secret_manager(&db_path)
            .unwrap_or_else(|err| panic!("Secret init failed: {err}"));

        let mut vault = Vault {
            conn,
            db_path,
            master_password_hash,
            credentials,
            providers,
            prompts,
            provider_endpoints,
            provider_models,
            provider_env_vars,
            provider_app_bindings,
            secret_manager,
        };
        vault.ensure_default_providers();
        vault.ensure_usage_provider_settings();
        vault.ensure_global_settings_defaults();
        vault.ensure_app_routes_defaults();
        vault.refresh_app_integration_detection();
        vault.migrate_legacy_secrets();
        vault
    }

    pub fn set_master_password(&mut self, password: &str) -> Result<(), String> {
        if self.master_password_hash.is_some() {
            return Err("Master password already set".to_string());
        }
        let hash = Self::hash_master_password(password)?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('master_password_hash', ?1)",
                params![hash],
            )
            .map_err(|e| e.to_string())?;
        self.master_password_hash = Some(hash);
        Ok(())
    }

    pub fn authenticate(&self, password: &str) -> bool {
        if let Some(ref hash) = self.master_password_hash {
            if Self::verify_master_password(hash, password) {
                if Self::is_legacy_md5_hash(hash) {
                    if let Ok(upgraded_hash) = Self::hash_master_password(password) {
                        let _ = self.conn.execute(
                            "INSERT OR REPLACE INTO meta (key, value) VALUES ('master_password_hash', ?1)",
                            params![upgraded_hash],
                        );
                    }
                }
                let _ = self.secret_manager.unlock_all(password);
                true
            } else {
                false
            }
        } else {
            false
        }
    }

    pub fn is_password_set(&self) -> bool {
        self.master_password_hash.is_some()
    }

    fn hash_master_password(password: &str) -> Result<String, String> {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|result| result.to_string())
            .map_err(|e| format!("Failed to hash master password: {}", e))
    }

    fn verify_master_password(stored_hash: &str, password: &str) -> bool {
        if stored_hash.starts_with("$argon2") {
            let parsed_hash = match PasswordHash::new(stored_hash) {
                Ok(value) => value,
                Err(_) => return false,
            };
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed_hash)
                .is_ok()
        } else {
            let input_hash = format!("{:x}", md5::compute(password.as_bytes()));
            stored_hash == input_hash
        }
    }

    fn is_legacy_md5_hash(stored_hash: &str) -> bool {
        stored_hash.len() == 32 && stored_hash.chars().all(|c| c.is_ascii_hexdigit())
    }

    pub fn add_credential(
        &mut self,
        provider: String,
        name: String,
        key: String,
        source: Option<String>,
    ) -> Result<Credential, String> {
        let id = Uuid::new_v4().to_string();
        let now = Local::now().to_rfc3339();
        let secret = Secret {
            value: key.clone(),
            metadata: SecretMetadata {
                provider: provider.clone(),
                created_at: None,
                updated_at: None,
                tags: Vec::new(),
                note: None,
            },
        };
        self.secret_manager
            .set(&id, &secret)
            .map_err(|e| e.to_string())?;
        let credential = Credential {
            id: id.clone(),
            provider,
            name,
            key: mask_key(&key),
            created_at: now,
            is_active: true,
            source,
        };

        self.conn
            .execute(
                "INSERT INTO credentials (id, provider, name, secret_key, created_at, is_active, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    credential.id,
                    credential.provider,
                    credential.name,
                    credential.key,
                    credential.created_at,
                    bool_to_int(credential.is_active),
                    credential.source,
                ],
            )
            .map_err(|e| e.to_string())?;

        self.credentials.insert(id, credential.clone());
        Ok(credential)
    }

    pub fn get_credentials(&self) -> Vec<Credential> {
        self.credentials
            .values()
            .map(|cred| self.resolve_credential(cred))
            .collect()
    }

    pub fn get_credential(&self, id: &str) -> Option<Credential> {
        self.credentials
            .get(id)
            .map(|cred| self.resolve_credential(cred))
    }

    pub fn update_credential(
        &mut self,
        id: String,
        provider: String,
        name: String,
        key: String,
    ) -> Result<Credential, String> {
        if !self.credentials.contains_key(&id) {
            return Err("Credential not found".to_string());
        }

        let secret = Secret {
            value: key.clone(),
            metadata: SecretMetadata {
                provider: provider.clone(),
                created_at: None,
                updated_at: None,
                tags: Vec::new(),
                note: None,
            },
        };
        self.secret_manager
            .set(&id, &secret)
            .map_err(|e| e.to_string())?;

        let mut credential = self.credentials.get(&id).unwrap().clone();
        credential.provider = provider;
        credential.name = name;
        credential.key = mask_key(&key);

        self.conn
            .execute(
                "UPDATE credentials SET provider = ?1, name = ?2, secret_key = ?3 WHERE id = ?4",
                params![
                    credential.provider,
                    credential.name,
                    credential.key,
                    credential.id
                ],
            )
            .map_err(|e| e.to_string())?;

        self.credentials.insert(id, credential.clone());
        Ok(credential)
    }

    pub fn get_credential_project_labels(&self) -> Result<HashMap<String, String>, String> {
        let mut labels = HashMap::new();
        for credential_id in self.credentials.keys() {
            let secret_id = project_label_secret_id(credential_id);
            if let Ok(secret) = self.secret_manager.get(&secret_id) {
                let value = secret.value.trim().to_string();
                if !value.is_empty() {
                    labels.insert(credential_id.clone(), value);
                }
            }
        }
        Ok(labels)
    }

    pub fn set_credential_project_label(
        &mut self,
        credential_id: String,
        label: Option<String>,
    ) -> Result<(), String> {
        if !self.credentials.contains_key(&credential_id) {
            return Err("Credential not found".to_string());
        }

        let secret_id = project_label_secret_id(&credential_id);
        let normalized = label.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });

        if let Some(value) = normalized {
            let secret = Secret {
                value,
                metadata: SecretMetadata {
                    provider: "project".to_string(),
                    created_at: None,
                    updated_at: None,
                    tags: vec!["project-label".to_string()],
                    note: Some("credential_project_label".to_string()),
                },
            };
            self.secret_manager
                .set(&secret_id, &secret)
                .map_err(|e| e.to_string())?;
        } else {
            let _ = self.secret_manager.delete(&secret_id);
        }

        Ok(())
    }

    pub fn delete_credential(&mut self, id: &str) -> Result<(), String> {
        if self.credentials.remove(id).is_none() {
            return Err("Credential not found".to_string());
        }
        let _ = self.secret_manager.delete(id);
        let _ = self.secret_manager.delete(&project_label_secret_id(id));
        self.conn
            .execute("DELETE FROM credentials WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_providers(&self) -> Vec<ProviderConfig> {
        let mut providers: Vec<ProviderConfig> = self
            .providers
            .values()
            .map(|provider| self.decorate_provider(provider))
            .collect();
        providers.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        providers
    }

    pub fn get_provider_config(&self, provider: &str) -> Option<ProviderConfig> {
        self.providers
            .get(provider)
            .map(|config| self.decorate_provider(config))
    }

    pub fn get_latest_credential_for_provider(&self, provider: &str) -> Option<Credential> {
        let mut items: Vec<Credential> = self
            .credentials
            .values()
            .filter(|cred| cred.provider == provider)
            .map(|cred| self.resolve_credential(cred))
            .collect();

        items.sort_by(|a, b| {
            let a_time = chrono::DateTime::parse_from_rfc3339(&a.created_at)
                .map(|dt| dt.timestamp())
                .unwrap_or(0);
            let b_time = chrono::DateTime::parse_from_rfc3339(&b.created_at)
                .map(|dt| dt.timestamp())
                .unwrap_or(0);
            b_time.cmp(&a_time)
        });

        items.into_iter().next()
    }

    fn resolve_credential(&self, credential: &Credential) -> Credential {
        let mut resolved = credential.clone();
        if let Ok(secret) = self.secret_manager.get(&credential.id) {
            resolved.key = secret.value;
        }
        resolved
    }

    fn decorate_provider(&self, provider: &ProviderConfig) -> ProviderConfig {
        let mut enriched = provider.clone();
        enriched.endpoints = self
            .provider_endpoints
            .get(&provider.provider)
            .cloned()
            .unwrap_or_default();
        enriched.env_vars = self
            .provider_env_vars
            .get(&provider.provider)
            .cloned()
            .unwrap_or_default();
        enriched.app_bindings = self
            .provider_app_bindings
            .get(&provider.provider)
            .cloned()
            .unwrap_or_default();
        enriched
    }

    pub fn upsert_provider(
        &mut self,
        provider: String,
        api_key: String,
        base_url: String,
        models: Vec<String>,
    ) -> Result<ProviderConfig, String> {
        let now = Local::now().to_rfc3339();
        let entry = self
            .providers
            .entry(provider.clone())
            .or_insert_with(|| ProviderConfig {
                provider: provider.clone(),
                label: provider.clone(),
                api_key: String::new(),
                base_url: String::new(),
                updated_at: now.clone(),
                is_active: false,
                models: Vec::new(),
                endpoints: Vec::new(),
                env_vars: Vec::new(),
                app_bindings: Vec::new(),
            });

        entry.api_key = api_key;
        entry.base_url = base_url;
        entry.models = models;
        entry.updated_at = now.clone();
        entry.is_active = !entry.api_key.trim().is_empty();

        let models_json = serde_json::to_string(&entry.models).unwrap_or_else(|_| "[]".to_string());
        self.conn
            .execute(
                "INSERT INTO providers (provider, label, api_key, base_url, updated_at, is_active, models)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(provider) DO UPDATE SET
                   api_key = excluded.api_key,
                   base_url = excluded.base_url,
                   updated_at = excluded.updated_at,
                   is_active = excluded.is_active,
                   models = excluded.models",
                params![
                    entry.provider,
                    entry.label,
                    entry.api_key,
                    entry.base_url,
                    entry.updated_at,
                    bool_to_int(entry.is_active),
                    models_json,
                ],
            )
            .map_err(|e| e.to_string())?;

        let updated = entry.clone();
        Ok(self.decorate_provider(&updated))
    }

    pub fn set_provider_active(
        &mut self,
        provider: &str,
        is_active: bool,
    ) -> Result<ProviderConfig, String> {
        let now = Local::now().to_rfc3339();
        let entry = self
            .providers
            .get_mut(provider)
            .ok_or_else(|| format!("Provider not found: {}", provider))?;
        entry.is_active = is_active;
        entry.updated_at = now.clone();

        self.conn
            .execute(
                "UPDATE providers SET is_active = ?1, updated_at = ?2 WHERE provider = ?3",
                params![bool_to_int(is_active), now, provider],
            )
            .map_err(|e| e.to_string())?;

        let updated = entry.clone();
        Ok(self.decorate_provider(&updated))
    }

    pub fn delete_provider(&mut self, provider: &str) -> Result<(), String> {
        let provider = provider.trim();
        if provider.is_empty() {
            return Err("Provider cannot be empty".to_string());
        }
        if Self::is_builtin_provider(provider) {
            return Err("内置服务不支持删除，可改为停用。".to_string());
        }
        if self
            .credentials
            .values()
            .any(|credential| credential.provider == provider)
        {
            return Err("该服务仍被密钥库引用，请先迁移或删除相关密钥。".to_string());
        }

        self.conn
            .execute(
                "DELETE FROM providers WHERE provider = ?1",
                params![provider],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM provider_endpoints WHERE provider = ?1",
                params![provider],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM provider_models WHERE provider = ?1",
                params![provider],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM provider_env_vars WHERE provider = ?1",
                params![provider],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM provider_apps WHERE provider = ?1",
                params![provider],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM usage_provider_settings WHERE provider = ?1",
                params![provider],
            )
            .map_err(|e| e.to_string())?;

        self.providers.remove(provider);
        self.provider_endpoints.remove(provider);
        self.provider_models.remove(provider);
        self.provider_env_vars.remove(provider);
        self.provider_app_bindings.remove(provider);
        Ok(())
    }

    pub fn get_prompts(&self) -> Vec<PromptTemplate> {
        let mut prompts: Vec<PromptTemplate> = self.prompts.values().cloned().collect();
        prompts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        prompts
    }

    pub fn upsert_prompt(
        &mut self,
        id: Option<String>,
        title: String,
        content: String,
        model: String,
        variables: Vec<String>,
    ) -> Result<PromptTemplate, String> {
        let now = Local::now().to_rfc3339();
        let prompt_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at = self
            .prompts
            .get(&prompt_id)
            .map(|p| p.created_at.clone())
            .unwrap_or_else(|| now.clone());

        let prompt = PromptTemplate {
            id: prompt_id.clone(),
            title,
            content,
            model,
            variables,
            created_at,
            updated_at: now.clone(),
        };

        let vars_json =
            serde_json::to_string(&prompt.variables).unwrap_or_else(|_| "[]".to_string());
        self.conn
            .execute(
                "INSERT INTO prompts (id, title, content, model, variables, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title,
                   content = excluded.content,
                   model = excluded.model,
                   variables = excluded.variables,
                   updated_at = excluded.updated_at",
                params![
                    prompt.id,
                    prompt.title,
                    prompt.content,
                    prompt.model,
                    vars_json,
                    prompt.created_at,
                    prompt.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;

        self.prompts.insert(prompt.id.clone(), prompt.clone());
        Ok(prompt)
    }

    pub fn delete_prompt(&mut self, id: &str) -> Result<(), String> {
        if self.prompts.remove(id).is_none() {
            return Err("Prompt not found".to_string());
        }
        self.conn
            .execute("DELETE FROM prompts WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn migrate_legacy_secrets(&mut self) {
        let legacy: Vec<(String, String)> = self
            .credentials
            .iter()
            .map(|(id, cred)| (id.clone(), cred.key.clone()))
            .collect();

        for (id, legacy_key) in legacy {
            if legacy_key.trim().is_empty() {
                continue;
            }
            if self.secret_manager.exists(&id).unwrap_or(false) {
                continue;
            }

            let secret = Secret {
                value: legacy_key.clone(),
                metadata: SecretMetadata {
                    provider: "sqlite".to_string(),
                    created_at: None,
                    updated_at: None,
                    tags: Vec::new(),
                    note: Some("migrated_from_credentials".to_string()),
                },
            };

            if self.secret_manager.set(&id, &secret).is_ok() {
                let masked = mask_key(&legacy_key);
                if let Some(cred) = self.credentials.get_mut(&id) {
                    cred.key = masked.clone();
                }
                let _ = self.conn.execute(
                    "UPDATE credentials SET secret_key = ?1 WHERE id = ?2",
                    params![masked, id],
                );
            }
        }
    }

    fn init_secret_manager(db_path: &PathBuf) -> Result<SecretManager, String> {
        let config = Self::load_secret_store_config(db_path)?;
        SecretManager::from_config(&config).map_err(|e| e.to_string())
    }

    fn load_secret_store_config(db_path: &PathBuf) -> Result<SecretStoreConfig, String> {
        let base = db_path.parent().unwrap_or(Path::new("."));
        let config_path = base.join("secret_store.toml");
        if config_path.exists() {
            let raw = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
            toml::from_str(&raw).map_err(|e| e.to_string())
        } else {
            Ok(SecretStoreConfig::default_with_path(db_path))
        }
    }

    fn open_db() -> Result<(Connection, PathBuf), String> {
        let mut base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        base.push("MyKey");
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let db_path = base.join("vault.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        Ok((conn, db_path))
    }

    fn migrate(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                name TEXT NOT NULL,
                secret_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                is_active INTEGER NOT NULL,
                source TEXT
            );
            CREATE TABLE IF NOT EXISTS providers (
                provider TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                api_key TEXT NOT NULL,
                base_url TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                is_active INTEGER NOT NULL,
                models TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS prompts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                model TEXT NOT NULL,
                variables TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS provider_endpoints (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                base_url TEXT NOT NULL,
                headers TEXT,
                timeout_ms INTEGER,
                proxy_url TEXT,
                is_primary INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS provider_models (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                name TEXT NOT NULL,
                alias TEXT,
                context_window INTEGER,
                input_price REAL,
                output_price REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS provider_env_vars (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                is_secret INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS provider_apps (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                app_type TEXT NOT NULL,
                config_path TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_provider_settings (
                provider TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_snapshots (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                account_tier TEXT,
                account_email TEXT
            );
            CREATE TABLE IF NOT EXISTS usage_quotas (
                id TEXT PRIMARY KEY,
                snapshot_id TEXT NOT NULL,
                quota_type TEXT NOT NULL,
                label TEXT NOT NULL,
                percent_remaining REAL NOT NULL,
                reset_at TEXT,
                reset_text TEXT,
                FOREIGN KEY(snapshot_id) REFERENCES usage_snapshots(id)
            );
            CREATE TABLE IF NOT EXISTS usage_costs (
                snapshot_id TEXT PRIMARY KEY,
                total_cost REAL NOT NULL,
                budget REAL,
                FOREIGN KEY(snapshot_id) REFERENCES usage_snapshots(id)
            );
            CREATE TABLE IF NOT EXISTS app_integrations (
                id TEXT PRIMARY KEY,
                app_type TEXT NOT NULL UNIQUE,
                detected INTEGER NOT NULL,
                enabled INTEGER NOT NULL,
                config_path TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_routes (
                app_type TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS service_runtime (
                service_name TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL,
                auto_start INTEGER NOT NULL,
                port INTEGER,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS gateway_request_logs (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                app_type TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT,
                endpoint TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                latency_ms INTEGER NOT NULL,
                blocked_reason TEXT,
                error_code TEXT,
                estimated_cost_usd REAL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                credential_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(credential_id) REFERENCES credentials(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_provider_endpoints_provider ON provider_endpoints(provider);
            CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider);
            CREATE INDEX IF NOT EXISTS idx_provider_env_vars_provider ON provider_env_vars(provider);
            CREATE INDEX IF NOT EXISTS idx_provider_apps_provider ON provider_apps(provider);
            CREATE INDEX IF NOT EXISTS idx_usage_snapshots_provider ON usage_snapshots(provider_id);
            CREATE INDEX IF NOT EXISTS idx_app_integrations_app_type ON app_integrations(app_type);
            CREATE INDEX IF NOT EXISTS idx_projects_credential_id ON projects(credential_id);
            CREATE INDEX IF NOT EXISTS idx_gateway_logs_created_at ON gateway_request_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_gateway_logs_app_type ON gateway_request_logs(app_type);",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn ensure_usage_provider_settings(&mut self) {
        let legacy_claude_cli_enabled = self
            .conn
            .query_row(
                "SELECT enabled FROM usage_provider_settings WHERE provider = 'anthropic-cli'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten();

        if let Some(enabled) = legacy_claude_cli_enabled {
            let _ = self.conn.execute(
                "INSERT OR IGNORE INTO usage_provider_settings (provider, enabled) VALUES ('claude-code', ?1)",
                params![enabled],
            );
        }

        let providers = [
            "openai",
            "anthropic",
            "antigravity",
            "claude-code",
            "opencode",
            "openclaw",
            "gemini",
            "kimi",
            "amp",
        ];
        for provider in providers {
            let _ = self.conn.execute(
                "INSERT OR IGNORE INTO usage_provider_settings (provider, enabled) VALUES (?1, 1)",
                params![provider],
            );
        }
    }

    pub fn get_usage_provider_settings(&self) -> Result<HashMap<String, bool>, String> {
        let mut map = HashMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT provider, enabled FROM usage_provider_settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let provider: String = row.get(0)?;
                let enabled: i64 = row.get(1)?;
                Ok((provider, enabled != 0))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (provider, enabled) = row.map_err(|e| e.to_string())?;
            map.insert(provider, enabled);
        }
        Ok(map)
    }

    pub fn set_usage_provider_enabled(
        &mut self,
        provider: &str,
        enabled: bool,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO usage_provider_settings (provider, enabled) VALUES (?1, ?2)
                 ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled",
                params![provider, if enabled { 1 } else { 0 }],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_usage_snapshot(&mut self, snapshot: &UsageSnapshot) -> Result<(), String> {
        let snapshot_id = Uuid::new_v4().to_string();
        self.conn
            .execute(
                "INSERT INTO usage_snapshots (id, provider_id, captured_at, account_tier, account_email)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    snapshot_id,
                    snapshot.provider_id,
                    snapshot.captured_at,
                    snapshot.account_tier,
                    snapshot.account_email
                ],
            )
            .map_err(|e| e.to_string())?;

        for quota in &snapshot.quotas {
            let quota_id = Uuid::new_v4().to_string();
            self.conn
                .execute(
                    "INSERT INTO usage_quotas (id, snapshot_id, quota_type, label, percent_remaining, reset_at, reset_text)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        quota_id,
                        snapshot_id,
                        quota.quota_type,
                        quota.label,
                        quota.percent_remaining,
                        quota.reset_at,
                        quota.reset_text
                    ],
                )
                .map_err(|e| e.to_string())?;
        }

        if let Some(cost) = &snapshot.cost_usage {
            self.conn
                .execute(
                    "INSERT OR REPLACE INTO usage_costs (snapshot_id, total_cost, budget)
                     VALUES (?1, ?2, ?3)",
                    params![snapshot_id, cost.total_cost, cost.budget],
                )
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub fn load_latest_usage_snapshots(&self) -> Result<Vec<UsageSnapshot>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, provider_id, captured_at, account_tier, account_email
                 FROM usage_snapshots
                 ORDER BY captured_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut latest: HashMap<String, (String, String, Option<String>, Option<String>)> =
            HashMap::new();
        for row in rows {
            let (id, provider_id, captured_at, account_tier, account_email) =
                row.map_err(|e| e.to_string())?;
            if !latest.contains_key(&provider_id) {
                latest.insert(provider_id, (id, captured_at, account_tier, account_email));
            }
        }

        let mut snapshots = Vec::new();
        for (provider_id, (snapshot_id, captured_at, account_tier, account_email)) in latest {
            let mut quota_stmt = self
                .conn
                .prepare(
                    "SELECT quota_type, label, percent_remaining, reset_at, reset_text
                     FROM usage_quotas WHERE snapshot_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let quotas_iter = quota_stmt
                .query_map(params![snapshot_id], |row| {
                    Ok(UsageQuota {
                        quota_type: row.get(0)?,
                        label: row.get(1)?,
                        percent_remaining: row.get(2)?,
                        reset_at: row.get(3)?,
                        reset_text: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            let mut quotas = Vec::new();
            for q in quotas_iter {
                quotas.push(q.map_err(|e| e.to_string())?);
            }

            let mut cost_stmt = self
                .conn
                .prepare("SELECT total_cost, budget FROM usage_costs WHERE snapshot_id = ?1")
                .map_err(|e| e.to_string())?;
            let cost = cost_stmt
                .query_row(params![snapshot_id], |row| {
                    Ok(CostUsage {
                        total_cost: row.get(0)?,
                        budget: row.get(1)?,
                    })
                })
                .optional()
                .map_err(|e| e.to_string())?;

            snapshots.push(UsageSnapshot {
                provider_id,
                captured_at,
                quotas,
                cost_usage: cost,
                account_tier,
                account_email,
            });
        }

        Ok(snapshots)
    }

    pub fn load_usage_trend(
        &self,
        provider_id: &str,
        limit: i64,
    ) -> Result<Vec<(String, Option<f64>, Option<f64>)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, captured_at FROM usage_snapshots
                 WHERE provider_id = ?1
                 ORDER BY captured_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![provider_id, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        let mut points: Vec<(String, Option<f64>, Option<f64>)> = Vec::new();
        for row in rows {
            let (snapshot_id, captured_at) = row.map_err(|e| e.to_string())?;

            let cost = self
                .conn
                .prepare("SELECT total_cost FROM usage_costs WHERE snapshot_id = ?1")
                .map_err(|e| e.to_string())?
                .query_row(params![snapshot_id], |row| row.get::<_, f64>(0))
                .optional()
                .map_err(|e| e.to_string())?;

            let quota = self
                .conn
                .prepare(
                    "SELECT percent_remaining FROM usage_quotas
                     WHERE snapshot_id = ?1 AND quota_type = 'session'
                     LIMIT 1",
                )
                .map_err(|e| e.to_string())?
                .query_row(params![snapshot_id], |row| row.get::<_, f64>(0))
                .optional()
                .map_err(|e| e.to_string())?
                .or_else(|| {
                    self.conn
                        .prepare(
                            "SELECT percent_remaining FROM usage_quotas
                             WHERE snapshot_id = ?1 AND quota_type = 'weekly'
                             LIMIT 1",
                        )
                        .ok()?
                        .query_row(params![snapshot_id], |row| row.get::<_, f64>(0))
                        .optional()
                        .ok()
                        .flatten()
                })
                .or_else(|| {
                    self.conn
                        .prepare(
                            "SELECT percent_remaining FROM usage_quotas
                             WHERE snapshot_id = ?1
                             LIMIT 1",
                        )
                        .ok()?
                        .query_row(params![snapshot_id], |row| row.get::<_, f64>(0))
                        .optional()
                        .ok()
                        .flatten()
                });

            points.push((captured_at, cost, quota));
        }

        points.reverse();
        Ok(points)
    }

    fn ensure_global_settings_defaults(&mut self) {
        let now = Local::now().to_rfc3339();

        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('debug_mode', 'false')",
            [],
        );
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('log_level', 'info')",
            [],
        );
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('gateway_circuit_breaker', 'false')",
            [],
        );
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('gateway_daily_budget_usd', '')",
            [],
        );

        for (service_name, enabled, auto_start, port) in [
            ("gateway", true, false, Some(8888_i64)),
            ("usage-probe", true, true, None),
        ] {
            let _ = self.conn.execute(
                "INSERT OR IGNORE INTO service_runtime (service_name, enabled, auto_start, port, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    service_name,
                    bool_to_int(enabled),
                    bool_to_int(auto_start),
                    port,
                    &now
                ],
            );
        }

        for (app_type, default_enabled) in [
            ("claude-code", false),
            ("codex", false),
            ("gemini", false),
            ("github", false),
            ("antigravity", false),
            ("z.ai", false),
            ("amp", false),
            ("aws", false),
            ("cursor", false),
            ("opencode", false),
            ("openclaw", false),
            ("openai-compatible", true),
        ] {
            let config_path = Self::default_integration_path(app_type);
            let detected = Self::detect_integration(app_type, config_path.as_deref());
            let _ = self.conn.execute(
                "INSERT OR IGNORE INTO app_integrations (id, app_type, detected, enabled, config_path, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    app_type,
                    bool_to_int(detected),
                    bool_to_int(default_enabled),
                    config_path,
                    &now
                ],
            );
        }
    }

    pub fn get_global_settings(&mut self) -> Result<GlobalSettingsPayload, String> {
        self.refresh_app_integration_detection();

        let debug_mode = self.get_debug_mode()?;
        let log_level = self.meta_get("log_level")?.unwrap_or_else(|| {
            if debug_mode {
                "debug".to_string()
            } else {
                "info".to_string()
            }
        });
        let integrations = self.get_app_integrations()?;
        let services = self.get_service_configs()?;
        let last_backup_at = self.meta_get("last_backup_at")?;
        let logs_dir = self.db_path.parent().unwrap_or(Path::new(".")).join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        let logs_path = logs_dir.to_string_lossy().to_string();

        Ok(GlobalSettingsPayload {
            debug_mode,
            log_level,
            integrations,
            services,
            database_path: self.db_path.to_string_lossy().to_string(),
            logs_path,
            last_backup_at,
        })
    }

    pub fn set_global_debug_mode(&mut self, enabled: bool) -> Result<(), String> {
        self.meta_set("debug_mode", if enabled { "true" } else { "false" })?;
        self.meta_set("log_level", if enabled { "debug" } else { "info" })?;
        Ok(())
    }

    pub fn set_global_integration_enabled(
        &mut self,
        app_type: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let now = Local::now().to_rfc3339();
        let path = self
            .get_integration_path(app_type)?
            .or_else(|| Self::default_integration_path(app_type));
        let detected = Self::detect_integration(app_type, path.as_deref());

        self.conn
            .execute(
                "INSERT INTO app_integrations (id, app_type, detected, enabled, config_path, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(app_type) DO UPDATE SET
                    detected = excluded.detected,
                    enabled = excluded.enabled,
                    config_path = excluded.config_path,
                    updated_at = excluded.updated_at",
                params![
                    Uuid::new_v4().to_string(),
                    app_type,
                    bool_to_int(detected),
                    bool_to_int(enabled),
                    path,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn default_route_provider(app_type: &str) -> &'static str {
        match app_type {
            "claude" | "claude-code" => "anthropic",
            "gemini" => "gemini",
            "github" => "github-copilot",
            "antigravity" => "antigravity",
            "z.ai" => "zai",
            "amp" => "amp",
            "aws" => "bedrock",
            "codex" | "cursor" | "opencode" | "openclaw" => "openai",
            _ => "openai",
        }
    }

    fn ensure_app_routes_defaults(&mut self) {
        let now = Local::now().to_rfc3339();
        for app_type in [
            "claude-code",
            "codex",
            "gemini",
            "github",
            "antigravity",
            "z.ai",
            "amp",
            "aws",
            "cursor",
            "opencode",
            "openclaw",
        ] {
            let _ = self.conn.execute(
                "INSERT OR IGNORE INTO app_routes (app_type, provider, model, updated_at)
                 VALUES (?1, ?2, NULL, ?3)",
                params![app_type, Self::default_route_provider(app_type), &now],
            );
        }

        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO app_routes (app_type, provider, model, updated_at)
             SELECT 'claude-code', provider, model, updated_at
             FROM app_routes
             WHERE app_type = 'claude'
             LIMIT 1",
            [],
        );
    }

    pub fn get_app_routes(&mut self) -> Result<Vec<AppRoute>, String> {
        self.ensure_app_routes_defaults();

        let mut stmt = self
            .conn
            .prepare(
                "SELECT app_type, provider, model, updated_at
                 FROM app_routes
                 ORDER BY app_type ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AppRoute {
                    app_type: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }

        let has_claude_code = items.iter().any(|item| item.app_type == "claude-code");
        if has_claude_code {
            items.retain(|item| item.app_type != "claude");
        }
        items.retain(|item| item.app_type != "openai-compatible");
        Ok(items)
    }

    fn sync_provider_binding_for_route(
        &mut self,
        app_type: &str,
        provider: &str,
        now: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE provider_apps
                 SET enabled = 0, updated_at = ?1
                 WHERE app_type = ?2",
                params![now, app_type],
            )
            .map_err(|e| e.to_string())?;

        let existing_id = self
            .conn
            .query_row(
                "SELECT id FROM provider_apps WHERE provider = ?1 AND app_type = ?2 LIMIT 1",
                params![provider, app_type],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let config_path = self
            .get_integration_path(app_type)?
            .or_else(|| Self::default_integration_path(app_type))
            .unwrap_or_default();

        if let Some(id) = existing_id {
            self.conn
                .execute(
                    "UPDATE provider_apps
                     SET enabled = 1, config_path = ?1, updated_at = ?2
                     WHERE id = ?3",
                    params![config_path, now, id],
                )
                .map_err(|e| e.to_string())?;
        } else {
            self.conn
                .execute(
                    "INSERT INTO provider_apps (id, provider, app_type, config_path, enabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
                    params![
                        Uuid::new_v4().to_string(),
                        provider,
                        app_type,
                        config_path,
                        now,
                        now
                    ],
                )
                .map_err(|e| e.to_string())?;
        }

        self.provider_app_bindings =
            Self::load_provider_app_bindings(&self.conn).unwrap_or_default();
        Ok(())
    }

    fn resolve_claude_settings_path(&self) -> Result<PathBuf, String> {
        let mut config_path = self.get_integration_path("claude-code")?;
        if config_path
            .as_deref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            config_path = self.get_integration_path("claude")?;
        }
        let raw_path = config_path
            .or_else(|| Self::default_integration_path("claude-code"))
            .or_else(|| Self::default_integration_path("claude"))
            .ok_or_else(|| "Cannot resolve Claude Code settings path".to_string())?;
        Ok(Self::normalize_claude_settings_path(&raw_path))
    }

    fn normalize_claude_settings_path(raw_path: &str) -> PathBuf {
        let trimmed = raw_path.trim();
        let expanded = shellexpand::tilde(trimmed).to_string();
        let path = PathBuf::from(expanded);
        let looks_like_dir = trimmed.ends_with('/')
            || trimmed.ends_with('\\')
            || path.is_dir()
            || path.extension().is_none();
        if looks_like_dir {
            path.join("settings.json")
        } else {
            path
        }
    }

    fn resolve_integration_config_path(
        &self,
        app_type: &str,
        fallback_file_name: &str,
    ) -> Result<PathBuf, String> {
        let raw_path = self
            .get_integration_path(app_type)?
            .or_else(|| Self::default_integration_path(app_type))
            .ok_or_else(|| format!("Cannot resolve {} config path", app_type))?;
        let mut normalized = Self::normalize_config_path(&raw_path, fallback_file_name);
        if app_type == "claude-code"
            && normalized
                .to_string_lossy()
                .ends_with("/.claude/settings.json")
        {
            if let Some(home) = dirs::home_dir() {
                let claude_json = home.join(".claude.json");
                if claude_json.exists() {
                    normalized = claude_json;
                }
            }
        }
        Ok(normalized)
    }

    fn normalize_config_path(raw_path: &str, fallback_file_name: &str) -> PathBuf {
        let trimmed = raw_path.trim();
        let expanded = shellexpand::tilde(trimmed).to_string();
        let path = PathBuf::from(expanded);
        let looks_like_dir = trimmed.ends_with('/')
            || trimmed.ends_with('\\')
            || path.is_dir()
            || path.extension().is_none();
        if looks_like_dir {
            path.join(fallback_file_name)
        } else {
            path
        }
    }

    fn read_json_like_or_default(path: &Path) -> Result<Value, String> {
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            return Ok(serde_json::json!({}));
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("toml"))
            .unwrap_or(false)
        {
            let toml_value = raw
                .parse::<toml::Value>()
                .map_err(|e| format!("配置文件不是有效 TOML: {} ({})", path.display(), e))?;
            let json_value = serde_json::to_value(toml_value)
                .map_err(|e| format!("TOML 转 JSON 失败: {} ({})", path.display(), e))?;
            return Ok(json_value);
        }
        json5::from_str::<Value>(&raw)
            .map_err(|e| format!("配置文件不是有效 JSON/JSON5: {} ({})", path.display(), e))
    }

    fn write_json_config(path: &Path, value: &Value) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("toml"))
            .unwrap_or(false)
        {
            let toml_value: toml::Value =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            let payload = toml::to_string_pretty(&toml_value).map_err(|e| e.to_string())?;
            return std::fs::write(path, payload).map_err(|e| e.to_string());
        }
        let payload = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        std::fs::write(path, payload).map_err(|e| e.to_string())
    }

    fn ensure_object_field<'a>(
        parent: &'a mut Map<String, Value>,
        key: &str,
        path_hint: &Path,
    ) -> Result<&'a mut Map<String, Value>, String> {
        let value = parent
            .entry(key.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        value
            .as_object_mut()
            .ok_or_else(|| format!("配置字段 '{}' 必须为对象: {}", key, path_hint.display()))
    }

    fn normalized_provider_key(provider: &str) -> String {
        let mut out = String::new();
        let mut prev_dash = false;
        for ch in provider.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
                prev_dash = false;
            } else if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
        let out = out.trim_matches('-').to_string();
        if out.is_empty() {
            "provider".to_string()
        } else {
            out
        }
    }

    fn provider_label_or_id(&self, provider: &str) -> String {
        self.providers
            .get(provider)
            .map(|item| {
                if item.label.trim().is_empty() {
                    item.provider.clone()
                } else {
                    item.label.clone()
                }
            })
            .unwrap_or_else(|| provider.to_string())
    }

    fn opencode_npm_for_provider(provider: &str) -> &'static str {
        match provider {
            "anthropic" | "claude" | "claude-code" => "@ai-sdk/anthropic",
            "gemini" | "google-ai" => "@ai-sdk/google",
            "openai" => "@ai-sdk/openai",
            _ => "@ai-sdk/openai-compatible",
        }
    }

    fn openclaw_api_for_provider(provider: &str) -> &'static str {
        match provider {
            "anthropic" | "claude" | "claude-code" => "anthropic-messages",
            _ => "openai-completions",
        }
    }

    fn resolve_route_provider_auth(
        &self,
        provider: &str,
    ) -> Result<(String, Option<String>), String> {
        let config = self
            .get_provider_config(provider)
            .ok_or_else(|| format!("Provider not found: {}", provider))?;

        let api_key = if config.api_key.trim().is_empty() {
            self.get_latest_credential_for_provider(provider)
                .map(|cred| cred.key.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    format!(
                        "Provider '{}' 缺少 API Key，请先在提供商设置或密钥库中配置。",
                        provider
                    )
                })?
        } else {
            config.api_key.trim().to_string()
        };

        let base_url = config.base_url.trim();
        let base_url = if base_url.is_empty() {
            None
        } else {
            Some(base_url.to_string())
        };

        Ok((api_key, base_url))
    }

    fn gateway_port(&self) -> u16 {
        self.get_service_runtime("gateway")
            .ok()
            .flatten()
            .and_then(|(enabled, port)| {
                if !enabled {
                    return None;
                }
                port
            })
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(8888)
    }

    fn gateway_daily_budget_value(&self) -> Result<Option<f64>, String> {
        let Some(raw) = self.meta_get("gateway_daily_budget_usd")? else {
            return Ok(None);
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let value = trimmed
            .parse::<f64>()
            .map_err(|_| "Invalid gateway_daily_budget_usd value".to_string())?;
        if value <= 0.0 {
            return Ok(None);
        }
        Ok(Some(value))
    }

    fn gateway_circuit_breaker_enabled(&self) -> Result<bool, String> {
        let value = self
            .meta_get("gateway_circuit_breaker")?
            .unwrap_or_else(|| "false".to_string());
        let normalized = value.trim().to_ascii_lowercase();
        Ok(matches!(normalized.as_str(), "1" | "true" | "yes" | "on"))
    }

    fn gateway_today_metrics(&self) -> Result<(i64, f64), String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT COUNT(*), COALESCE(SUM(COALESCE(estimated_cost_usd, 0)), 0)
                 FROM gateway_request_logs
                 WHERE substr(created_at, 1, 10) = date('now', 'localtime')",
            )
            .map_err(|e| e.to_string())?;
        let (count, cost) = stmt
            .query_row([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))
            .map_err(|e| e.to_string())?;
        Ok((count, cost))
    }

    pub fn get_gateway_policy_settings(&self) -> Result<GatewayPolicySettings, String> {
        let circuit_breaker_enabled = self.gateway_circuit_breaker_enabled()?;
        let daily_budget_usd = self.gateway_daily_budget_value()?;
        let (today_request_count, today_cost_usd) = self.gateway_today_metrics()?;
        Ok(GatewayPolicySettings {
            circuit_breaker_enabled,
            daily_budget_usd,
            today_request_count,
            today_cost_usd,
        })
    }

    pub fn set_gateway_circuit_breaker(&self, enabled: bool) -> Result<(), String> {
        self.meta_set(
            "gateway_circuit_breaker",
            if enabled { "true" } else { "false" },
        )
    }

    pub fn set_gateway_daily_budget(&self, daily_budget_usd: Option<f64>) -> Result<(), String> {
        let normalized = daily_budget_usd
            .and_then(|value| if value > 0.0 { Some(value) } else { None })
            .map(|value| format!("{:.6}", value))
            .unwrap_or_default();
        self.meta_set("gateway_daily_budget_usd", &normalized)
    }

    pub fn check_gateway_policy_block_reason(&self) -> Result<Option<String>, String> {
        if self.gateway_circuit_breaker_enabled()? {
            return Ok(Some("global_circuit_breaker".to_string()));
        }
        if let Some(budget) = self.gateway_daily_budget_value()? {
            let (_, today_cost) = self.gateway_today_metrics()?;
            if today_cost >= budget {
                return Ok(Some("daily_budget_exceeded".to_string()));
            }
        }
        Ok(None)
    }

    pub fn append_gateway_request_log(&self, item: GatewayRequestLogInput) -> Result<(), String> {
        let now = Local::now().to_rfc3339();
        self.conn
            .execute(
                "INSERT INTO gateway_request_logs (
                    id, created_at, app_type, provider, model, endpoint,
                    status_code, latency_ms, blocked_reason, error_code, estimated_cost_usd
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    Uuid::new_v4().to_string(),
                    now,
                    item.app_type,
                    item.provider,
                    item.model,
                    item.endpoint,
                    item.status_code,
                    item.latency_ms,
                    item.blocked_reason,
                    item.error_code,
                    item.estimated_cost_usd,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_gateway_request_logs(&self, limit: i64) -> Result<Vec<GatewayRequestLog>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, created_at, app_type, provider, model, endpoint,
                        status_code, latency_ms, blocked_reason, error_code, estimated_cost_usd
                 FROM gateway_request_logs
                 ORDER BY created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(GatewayRequestLog {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    app_type: row.get(2)?,
                    provider: row.get(3)?,
                    model: row.get(4)?,
                    endpoint: row.get(5)?,
                    status_code: row.get(6)?,
                    latency_ms: row.get(7)?,
                    blocked_reason: row.get(8)?,
                    error_code: row.get(9)?,
                    estimated_cost_usd: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| e.to_string())?);
        }
        Ok(result)
    }

    fn gateway_base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.gateway_port())
    }

    fn gateway_token_key(app_type: &str) -> String {
        format!("gateway_token:{}", app_type)
    }

    fn get_or_create_gateway_token(&self, app_type: &str) -> Result<String, String> {
        let key = Self::gateway_token_key(app_type);
        if let Some(existing) = self.meta_get(&key)? {
            if !existing.trim().is_empty() {
                return Ok(existing);
            }
        }

        let token = format!(
            "sk-mykey-{}-{}",
            Self::normalized_provider_key(app_type),
            Uuid::new_v4().simple()
        );
        self.meta_set(&key, &token)?;
        Ok(token)
    }

    fn get_app_route_by_type(&self, app_type: &str) -> Result<Option<AppRoute>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT app_type, provider, model, updated_at FROM app_routes WHERE app_type = ?1 LIMIT 1",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt
            .query_row(params![app_type], |row| {
                Ok(AppRoute {
                    app_type: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row)
    }

    fn canonical_url_like(raw: &str) -> String {
        let mut value = raw.trim().to_ascii_lowercase();
        if let Some(stripped) = value.strip_prefix("https://") {
            value = stripped.to_string();
        } else if let Some(stripped) = value.strip_prefix("http://") {
            value = stripped.to_string();
        }
        value.trim_end_matches('/').to_string()
    }

    fn infer_provider_by_base_url(&self, base_url: &str) -> Option<String> {
        let target = Self::canonical_url_like(base_url);
        if target.is_empty() {
            return None;
        }

        let mut exact_match: Option<String> = None;
        for (provider_id, config) in &self.providers {
            let mut candidates = Vec::new();
            if !config.base_url.trim().is_empty() {
                candidates.push(config.base_url.as_str());
            }
            for endpoint in &config.endpoints {
                if !endpoint.base_url.trim().is_empty() {
                    candidates.push(endpoint.base_url.as_str());
                }
            }

            for candidate in candidates {
                let normalized = Self::canonical_url_like(candidate);
                if normalized.is_empty() {
                    continue;
                }
                if target == normalized {
                    return Some(provider_id.clone());
                }
                if exact_match.is_none()
                    && (target.starts_with(&normalized)
                        || normalized.starts_with(&target)
                        || target.contains(&normalized))
                {
                    exact_match = Some(provider_id.clone());
                }
            }
        }

        exact_match
    }

    fn infer_provider_by_model_key(&self, key: &str) -> Option<String> {
        let key = key.trim();
        if key.is_empty() {
            return None;
        }
        if self.providers.contains_key(key) {
            return Some(key.to_string());
        }
        let normalized = key.strip_prefix("mykey-").unwrap_or(key).trim().to_string();
        if normalized.is_empty() {
            return None;
        }
        self.providers.keys().find_map(|provider| {
            if Self::normalized_provider_key(provider) == normalized {
                Some(provider.clone())
            } else {
                None
            }
        })
    }

    fn detect_route_from_claude_config(&self, config: &Value) -> Option<(String, Option<String>)> {
        let root = config.as_object()?;
        let env = root.get("env").and_then(|value| value.as_object());
        let model = env
            .and_then(|map| map.get("ANTHROPIC_MODEL"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                root.get("model")
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            });

        let base_url = env
            .and_then(|map| map.get("ANTHROPIC_BASE_URL"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Some(url) = base_url {
            if url.contains("127.0.0.1") || url.contains("localhost") {
                if let Ok(Some(existing)) = self.get_app_route_by_type("claude-code") {
                    return Some((existing.provider, model));
                }
                return Some(("anthropic".to_string(), model));
            }
            if let Some(provider) = self.infer_provider_by_base_url(&url) {
                return Some((provider, model));
            }
        }

        if model.is_some() {
            return Some(("anthropic".to_string(), model));
        }
        None
    }

    fn detect_route_from_codex_config(&self, config: &Value) -> Option<(String, Option<String>)> {
        let root = config.as_object()?;
        let model = root
            .get("model")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let model_provider = root
            .get("model_provider")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Some(provider_key) = model_provider.as_deref() {
            if provider_key == "mykey" {
                if let Ok(Some(existing)) = self.get_app_route_by_type("codex") {
                    return Some((existing.provider, model));
                }
                return Some(("openai".to_string(), model));
            }
            if let Some(provider) = self.infer_provider_by_model_key(provider_key) {
                return Some((provider, model));
            }
        }

        let provider_from_base = root
            .get("model_providers")
            .and_then(|value| value.as_object())
            .and_then(|providers| {
                if let Some(selected) = model_provider.as_deref() {
                    providers
                        .get(selected)
                        .and_then(|entry| entry.as_object())
                        .and_then(|entry| entry.get("base_url"))
                        .and_then(|value| value.as_str())
                        .and_then(|url| self.infer_provider_by_base_url(url))
                } else {
                    providers.values().find_map(|entry| {
                        entry
                            .as_object()
                            .and_then(|obj| obj.get("base_url"))
                            .and_then(|value| value.as_str())
                            .and_then(|url| self.infer_provider_by_base_url(url))
                    })
                }
            });

        if let Some(provider) = provider_from_base {
            return Some((provider, model));
        }

        if model.is_some() {
            return Some(("openai".to_string(), model));
        }
        None
    }

    fn detect_route_from_opencode_config(
        &self,
        config: &Value,
        app_type: &str,
    ) -> Option<(String, Option<String>)> {
        let root = config.as_object()?;
        let model_ref = root
            .get("model")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (provider_key, model) = if let Some(reference) = model_ref {
            let mut parts = reference.splitn(2, '/');
            let provider_key = parts.next().unwrap_or_default().trim().to_string();
            let model = parts
                .next()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            (Some(provider_key), model)
        } else {
            (None, None)
        };

        if let Some(key) = provider_key.as_deref() {
            if let Some(provider) = self.infer_provider_by_model_key(key) {
                return Some((provider, model));
            }

            if let Some(base_url_provider) = root
                .get("provider")
                .and_then(|value| value.as_object())
                .and_then(|providers| providers.get(key))
                .and_then(|value| value.as_object())
                .and_then(|provider| provider.get("options"))
                .and_then(|value| value.as_object())
                .and_then(|options| options.get("baseURL").or_else(|| options.get("baseUrl")))
                .and_then(|value| value.as_str())
                .and_then(|url| self.infer_provider_by_base_url(url))
            {
                return Some((base_url_provider, model));
            }
        }

        if let Ok(Some(existing)) = self.get_app_route_by_type(app_type) {
            return Some((existing.provider, model.or(existing.model)));
        }
        None
    }

    fn detect_route_from_openclaw_config(
        &self,
        config: &Value,
    ) -> Option<(String, Option<String>)> {
        let root = config.as_object()?;
        let model_ref = root
            .get("agents")
            .and_then(|value| value.as_object())
            .and_then(|agents| agents.get("defaults"))
            .and_then(|value| value.as_object())
            .and_then(|defaults| defaults.get("model"))
            .and_then(|value| value.as_object())
            .and_then(|model| model.get("primary"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (provider_key, model) = if let Some(reference) = model_ref {
            let mut parts = reference.splitn(2, '/');
            let provider_key = parts.next().unwrap_or_default().trim().to_string();
            let model = parts
                .next()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            (Some(provider_key), model)
        } else {
            (None, None)
        };

        if let Some(key) = provider_key.as_deref() {
            if let Some(provider) = self.infer_provider_by_model_key(key) {
                return Some((provider, model));
            }

            if let Some(base_url_provider) = root
                .get("models")
                .and_then(|value| value.as_object())
                .and_then(|models| models.get("providers"))
                .and_then(|value| value.as_object())
                .and_then(|providers| providers.get(key))
                .and_then(|value| value.as_object())
                .and_then(|provider| provider.get("baseUrl").or_else(|| provider.get("baseURL")))
                .and_then(|value| value.as_str())
                .and_then(|url| self.infer_provider_by_base_url(url))
            {
                return Some((base_url_provider, model));
            }
        }

        if let Ok(Some(existing)) = self.get_app_route_by_type("openclaw") {
            return Some((existing.provider, model.or(existing.model)));
        }
        None
    }

    pub fn detect_app_route_from_live_config(
        &self,
        app_type: &str,
    ) -> Result<Option<AppRoute>, String> {
        let app_type = app_type.trim();
        if app_type.is_empty() {
            return Err("App type cannot be empty".to_string());
        }

        let snapshot = self.get_integration_config_snapshot(app_type)?;
        let detected = match app_type {
            "claude" | "claude-code" => self.detect_route_from_claude_config(&snapshot.config),
            "codex" => self.detect_route_from_codex_config(&snapshot.config),
            "opencode" => self.detect_route_from_opencode_config(&snapshot.config, app_type),
            "openclaw" => self.detect_route_from_openclaw_config(&snapshot.config),
            _ => None,
        };

        Ok(detected.map(|(provider, model)| AppRoute {
            app_type: app_type.to_string(),
            provider,
            model,
            updated_at: Local::now().to_rfc3339(),
        }))
    }

    pub fn get_gateway_access_credentials(
        &self,
        app_type: &str,
    ) -> Result<GatewayAccessCredentials, String> {
        let route = self
            .get_app_route_by_type(app_type)?
            .ok_or_else(|| format!("{} 尚未配置路由", app_type))?;
        let token = self.get_or_create_gateway_token(app_type)?;
        Ok(GatewayAccessCredentials {
            app_type: route.app_type,
            base_url: self.gateway_base_url(),
            api_key: token,
            provider: route.provider,
            model: route.model,
        })
    }

    pub fn resolve_gateway_route_by_token(
        &self,
        token: &str,
    ) -> Result<Option<GatewayResolvedRoute>, String> {
        let token = token.trim();
        if token.is_empty() {
            return Ok(None);
        }

        for app_type in ["claude-code", "codex"] {
            let expected = self.get_or_create_gateway_token(app_type)?;
            if expected != token {
                continue;
            }

            let Some(route) = self.get_app_route_by_type(app_type)? else {
                return Ok(None);
            };
            let (upstream_api_key, upstream_base_url) =
                self.resolve_route_provider_auth(&route.provider)?;
            return Ok(Some(GatewayResolvedRoute {
                app_type: route.app_type,
                provider: route.provider,
                model: route.model,
                upstream_api_key,
                upstream_base_url,
            }));
        }

        Ok(None)
    }

    fn apply_claude_code_route(&self, _provider: &str, model: Option<&str>) -> Result<(), String> {
        let settings_path = self.resolve_claude_settings_path()?;
        let gateway_token = self.get_or_create_gateway_token("claude-code")?;
        let gateway_base_url = self.gateway_base_url();

        let mut settings = if settings_path.exists() {
            let raw = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
            if raw.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str::<Value>(&raw).map_err(|e| {
                    format!(
                        "Claude settings 不是有效 JSON: {} ({})",
                        settings_path.display(),
                        e
                    )
                })?
            }
        } else {
            serde_json::json!({})
        };

        let root = settings.as_object_mut().ok_or_else(|| {
            format!(
                "Claude settings 根节点必须是对象: {}",
                settings_path.display()
            )
        })?;

        let env_value = root
            .entry("env".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !env_value.is_object() {
            return Err(format!(
                "Claude settings 的 env 字段必须是对象: {}",
                settings_path.display()
            ));
        }
        let env = env_value.as_object_mut().expect("env object checked above");

        env.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            Value::String(gateway_token.clone()),
        );
        env.insert(
            "ANTHROPIC_API_KEY".to_string(),
            Value::String(gateway_token.clone()),
        );
        env.insert(
            "MYKEY_GATEWAY_KEY".to_string(),
            Value::String(gateway_token),
        );
        env.insert(
            "MYKEY_GATEWAY_BASE_URL".to_string(),
            Value::String(gateway_base_url.clone()),
        );

        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            Value::String(gateway_base_url),
        );

        let model = model
            .map(|value| value.trim())
            .filter(|value| !value.is_empty());
        if let Some(model) = model {
            let model = model.to_string();
            env.insert("ANTHROPIC_MODEL".to_string(), Value::String(model.clone()));
            env.insert(
                "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
                Value::String(model.clone()),
            );
            env.insert(
                "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
                Value::String(model.clone()),
            );
            env.insert(
                "ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(),
                Value::String(model.clone()),
            );
            root.insert("model".to_string(), Value::String(model));
        } else {
            env.remove("ANTHROPIC_MODEL");
            env.remove("ANTHROPIC_DEFAULT_HAIKU_MODEL");
            env.remove("ANTHROPIC_DEFAULT_SONNET_MODEL");
            env.remove("ANTHROPIC_DEFAULT_OPUS_MODEL");
            root.remove("model");
        }

        if let Some(parent) = settings_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let payload = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&settings_path, payload).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn apply_codex_route(&self, model: Option<&str>) -> Result<(), String> {
        let config_path = self.resolve_integration_config_path("codex", "config.toml")?;
        let gateway_token = self.get_or_create_gateway_token("codex")?;
        let gateway_base_url = self.gateway_base_url();

        let mut config = Self::read_json_like_or_default(&config_path)?;
        let root = config
            .as_object_mut()
            .ok_or_else(|| format!("Codex 配置根节点必须是对象: {}", config_path.display()))?;

        let selected_model = model
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-5");

        root.insert(
            "model".to_string(),
            Value::String(selected_model.to_string()),
        );
        root.insert(
            "model_provider".to_string(),
            Value::String("mykey".to_string()),
        );

        let model_providers = Self::ensure_object_field(root, "model_providers", &config_path)?;
        let mut provider_obj = Map::new();
        provider_obj.insert(
            "name".to_string(),
            Value::String("MyKey Gateway".to_string()),
        );
        provider_obj.insert("base_url".to_string(), Value::String(gateway_base_url));
        provider_obj.insert(
            "wire_api".to_string(),
            Value::String("responses".to_string()),
        );

        let mut headers = Map::new();
        headers.insert(
            "Authorization".to_string(),
            Value::String(format!("Bearer {}", gateway_token)),
        );
        headers.insert("x-api-key".to_string(), Value::String(gateway_token));
        provider_obj.insert("http_headers".to_string(), Value::Object(headers));

        model_providers.insert("mykey".to_string(), Value::Object(provider_obj));
        Self::write_json_config(&config_path, &config)
    }

    fn apply_opencode_route(&self, provider: &str, model: Option<&str>) -> Result<(), String> {
        let config_path = self.resolve_integration_config_path("opencode", "opencode.json")?;
        let (api_key, base_url) = self.resolve_route_provider_auth(provider)?;
        let mut settings = Self::read_json_like_or_default(&config_path)?;

        let root = settings
            .as_object_mut()
            .ok_or_else(|| format!("OpenCode 配置根节点必须是对象: {}", config_path.display()))?;
        if root.get("$schema").is_none() {
            root.insert(
                "$schema".to_string(),
                Value::String("https://opencode.ai/config.json".to_string()),
            );
        }

        let provider_key = format!("mykey-{}", Self::normalized_provider_key(provider));
        let selected_model = model
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());

        let mut options = Map::new();
        options.insert("apiKey".to_string(), Value::String(api_key));
        if let Some(url) = base_url {
            options.insert("baseURL".to_string(), Value::String(url));
        }

        let mut provider_obj = Map::new();
        provider_obj.insert(
            "npm".to_string(),
            Value::String(Self::opencode_npm_for_provider(provider).to_string()),
        );
        provider_obj.insert(
            "name".to_string(),
            Value::String(self.provider_label_or_id(provider)),
        );
        provider_obj.insert("options".to_string(), Value::Object(options));

        let mut models = Map::new();
        if let Some(selected_model) = selected_model.as_ref() {
            let mut model_meta = Map::new();
            model_meta.insert("name".to_string(), Value::String(selected_model.clone()));
            models.insert(selected_model.clone(), Value::Object(model_meta));
        }
        provider_obj.insert("models".to_string(), Value::Object(models));

        {
            let providers = Self::ensure_object_field(root, "provider", &config_path)?;
            providers.insert(provider_key.clone(), Value::Object(provider_obj));
        }
        if let Some(selected_model) = selected_model {
            root.insert(
                "model".to_string(),
                Value::String(format!("{}/{}", provider_key, selected_model)),
            );
        }
        Self::write_json_config(&config_path, &settings)
    }

    fn integration_fallback_config_file_name(app_type: &str) -> &'static str {
        match app_type {
            "opencode" => "opencode.json",
            "openclaw" => "openclaw.json",
            "claude" | "claude-code" => "settings.json",
            "gemini" => "settings.json",
            "cursor" => "settings.json",
            "codex" => "config.json",
            _ => "config.json",
        }
    }

    fn apply_openclaw_route(&self, provider: &str, model: Option<&str>) -> Result<(), String> {
        let config_path = self.resolve_integration_config_path("openclaw", "openclaw.json")?;
        let (api_key, base_url) = self.resolve_route_provider_auth(provider)?;
        let mut settings = Self::read_json_like_or_default(&config_path)?;

        let root = settings
            .as_object_mut()
            .ok_or_else(|| format!("OpenClaw 配置根节点必须是对象: {}", config_path.display()))?;

        let provider_key = format!("mykey-{}", Self::normalized_provider_key(provider));
        {
            let models_root = Self::ensure_object_field(root, "models", &config_path)?;
            let providers = Self::ensure_object_field(models_root, "providers", &config_path)?;

            let mut provider_obj = Map::new();
            provider_obj.insert(
                "name".to_string(),
                Value::String(self.provider_label_or_id(provider)),
            );
            provider_obj.insert(
                "api".to_string(),
                Value::String(Self::openclaw_api_for_provider(provider).to_string()),
            );
            provider_obj.insert("apiKey".to_string(), Value::String(api_key));
            if let Some(url) = base_url {
                provider_obj.insert("baseUrl".to_string(), Value::String(url));
            }

            if let Some(selected_model) = model
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                let mut model_item = Map::new();
                model_item.insert("id".to_string(), Value::String(selected_model.to_string()));
                model_item.insert(
                    "name".to_string(),
                    Value::String(selected_model.to_string()),
                );
                provider_obj.insert(
                    "models".to_string(),
                    Value::Array(vec![Value::Object(model_item)]),
                );
            }

            providers.insert(provider_key.clone(), Value::Object(provider_obj));
        }

        if let Some(selected_model) = model
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            let model_ref = format!("{}/{}", provider_key, selected_model);
            let agents = Self::ensure_object_field(root, "agents", &config_path)?;
            let defaults = Self::ensure_object_field(agents, "defaults", &config_path)?;
            let defaults_model = Self::ensure_object_field(defaults, "model", &config_path)?;
            defaults_model.insert("primary".to_string(), Value::String(model_ref.clone()));

            let allowlist = Self::ensure_object_field(defaults, "models", &config_path)?;
            allowlist
                .entry(model_ref)
                .or_insert_with(|| Value::Object(Map::new()));
        }

        Self::write_json_config(&config_path, &settings)
    }

    pub fn set_app_route(
        &mut self,
        app_type: &str,
        provider: &str,
        model: Option<String>,
    ) -> Result<AppRoute, String> {
        let app_type = app_type.trim();
        let provider = provider.trim();
        if app_type.is_empty() {
            return Err("App type cannot be empty".to_string());
        }
        if provider.is_empty() {
            return Err("Provider cannot be empty".to_string());
        }
        if !self.providers.contains_key(provider) {
            return Err(format!("Provider not found: {}", provider));
        }
        let model = model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let now = Local::now().to_rfc3339();

        if matches!(app_type, "claude-code" | "claude") {
            self.apply_claude_code_route(provider, model.as_deref())?;
        }
        if app_type == "opencode" {
            self.apply_opencode_route(provider, model.as_deref())?;
        }
        if app_type == "openclaw" {
            self.apply_openclaw_route(provider, model.as_deref())?;
        }
        if app_type == "codex" {
            self.apply_codex_route(model.as_deref())?;
        }

        self.conn
            .execute(
                "INSERT INTO app_routes (app_type, provider, model, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(app_type) DO UPDATE SET
                    provider = excluded.provider,
                    model = excluded.model,
                    updated_at = excluded.updated_at",
                params![app_type, provider, model, &now],
            )
            .map_err(|e| e.to_string())?;

        self.sync_provider_binding_for_route(app_type, provider, &now)?;

        Ok(AppRoute {
            app_type: app_type.to_string(),
            provider: provider.to_string(),
            model,
            updated_at: now,
        })
    }

    pub fn get_opencode_config_snapshot(&self) -> Result<OpencodeConfigSnapshot, String> {
        let config_path = self.resolve_integration_config_path("opencode", "opencode.json")?;
        let config = Self::read_json_like_or_default(&config_path)?;
        Ok(OpencodeConfigSnapshot {
            config_path: config_path.display().to_string(),
            config,
        })
    }

    pub fn get_integration_config_snapshot(
        &self,
        app_type: &str,
    ) -> Result<IntegrationConfigSnapshot, String> {
        let app_type = app_type.trim();
        if app_type.is_empty() {
            return Err("App type cannot be empty".to_string());
        }
        let fallback_name = Self::integration_fallback_config_file_name(app_type);
        let config_path = self.resolve_integration_config_path(app_type, fallback_name)?;
        let config = Self::read_json_like_or_default(&config_path)?;
        Ok(IntegrationConfigSnapshot {
            app_type: app_type.to_string(),
            config_path: config_path.display().to_string(),
            config,
        })
    }

    pub fn save_opencode_config_snapshot(&self, config: Value) -> Result<bool, String> {
        if !config.is_object() {
            return Err("OpenCode 配置必须是 JSON 对象".to_string());
        }
        let config_path = self.resolve_integration_config_path("opencode", "opencode.json")?;
        Self::write_json_config(&config_path, &config)?;
        Ok(true)
    }

    pub fn save_integration_config_snapshot(
        &self,
        app_type: &str,
        config: Value,
    ) -> Result<bool, String> {
        let app_type = app_type.trim();
        if app_type.is_empty() {
            return Err("App type cannot be empty".to_string());
        }
        if !config.is_object() {
            return Err("配置必须是 JSON 对象".to_string());
        }
        let fallback_name = Self::integration_fallback_config_file_name(app_type);
        let config_path = self.resolve_integration_config_path(app_type, fallback_name)?;
        Self::write_json_config(&config_path, &config)?;
        Ok(true)
    }

    fn claude_tool_manager_db_path() -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        Some(
            home.join("Library")
                .join("Application Support")
                .join("com.claude-code-tool-manager.app")
                .join("mcp_library.db"),
        )
    }

    pub fn get_claude_tool_manager_mcps(&self) -> Result<Vec<ExternalLibraryMcp>, String> {
        let Some(path) = Self::claude_tool_manager_db_path() else {
            return Ok(Vec::new());
        };
        if !path.exists() {
            return Ok(Vec::new());
        }
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name, type, description, command, url, tags FROM mcps ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let tags_raw: Option<String> = row.get(5)?;
                let tags = tags_raw
                    .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
                    .unwrap_or_default();
                Ok(ExternalLibraryMcp {
                    name: row.get(0)?,
                    mcp_type: row.get(1)?,
                    description: row.get(2)?,
                    command: row.get(3)?,
                    url: row.get(4)?,
                    tags,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn get_claude_tool_manager_skills(&self) -> Result<Vec<ExternalLibrarySkill>, String> {
        let Some(path) = Self::claude_tool_manager_db_path() else {
            return Ok(Vec::new());
        };
        if !path.exists() {
            return Ok(Vec::new());
        }
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name, description, tags FROM skills ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let tags_raw: Option<String> = row.get(2)?;
                let tags = tags_raw
                    .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
                    .unwrap_or_default();
                Ok(ExternalLibrarySkill {
                    name: row.get(0)?,
                    description: row.get(1)?,
                    tags,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn set_global_service_enabled(
        &mut self,
        service_name: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let now = Local::now().to_rfc3339();
        self.conn
            .execute(
                "UPDATE service_runtime SET enabled = ?1, updated_at = ?2 WHERE service_name = ?3",
                params![bool_to_int(enabled), now, service_name],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_global_service_auto_start(
        &mut self,
        service_name: &str,
        auto_start: bool,
    ) -> Result<(), String> {
        let now = Local::now().to_rfc3339();
        self.conn
            .execute(
                "UPDATE service_runtime SET auto_start = ?1, updated_at = ?2 WHERE service_name = ?3",
                params![bool_to_int(auto_start), now, service_name],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_global_service_port(&mut self, service_name: &str, port: i64) -> Result<(), String> {
        if !(1..=65535).contains(&port) {
            return Err("Port must be between 1 and 65535".to_string());
        }
        let now = Local::now().to_rfc3339();
        self.conn
            .execute(
                "UPDATE service_runtime SET port = ?1, updated_at = ?2 WHERE service_name = ?3",
                params![port, now, service_name],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_service_runtime(
        &self,
        service_name: &str,
    ) -> Result<Option<(bool, Option<i64>)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT enabled, port
                 FROM service_runtime
                 WHERE service_name = ?1
                 LIMIT 1",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt
            .query_row(params![service_name], |row| {
                let enabled = int_to_bool(row.get::<_, i64>(0)?);
                let port = row.get::<_, Option<i64>>(1)?;
                Ok((enabled, port))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row)
    }

    pub fn create_backup(&mut self, target_dir: Option<String>) -> Result<String, String> {
        let now = Local::now();
        let backup_dir = target_dir
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                self.db_path
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join("backups")
            });
        std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

        let backup_path =
            backup_dir.join(format!("vault-backup-{}.db", now.format("%Y%m%d-%H%M%S")));
        let backup_path_string = backup_path.to_string_lossy().to_string();
        let escaped = backup_path_string.replace('\'', "''");

        let _ = self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let vacuum_sql = format!("VACUUM INTO '{}';", escaped);

        if let Err(vacuum_err) = self.conn.execute_batch(&vacuum_sql) {
            std::fs::copy(&self.db_path, &backup_path).map_err(|copy_err| {
                format!("Backup failed: {vacuum_err}; fallback copy failed: {copy_err}")
            })?;
        }

        self.meta_set("last_backup_at", &now.to_rfc3339())?;
        self.meta_set("backup_dir", &backup_dir.to_string_lossy())?;
        Ok(backup_path_string)
    }

    fn get_debug_mode(&self) -> Result<bool, String> {
        let value = self
            .meta_get("debug_mode")?
            .unwrap_or_else(|| "false".to_string());
        Ok(matches!(value.as_str(), "1" | "true" | "yes" | "on"))
    }

    fn refresh_app_integration_detection(&mut self) {
        let rows = {
            let mut stmt = match self
                .conn
                .prepare("SELECT app_type, config_path, enabled FROM app_integrations")
            {
                Ok(stmt) => stmt,
                Err(_) => return,
            };
            let iter = match stmt.query_map([], |row| {
                let app_type: String = row.get(0)?;
                let config_path: Option<String> = row.get(1)?;
                let enabled: i64 = row.get(2)?;
                Ok((app_type, config_path, enabled))
            }) {
                Ok(iter) => iter,
                Err(_) => return,
            };

            let mut rows = Vec::new();
            for row in iter {
                if let Ok(value) = row {
                    rows.push(value);
                }
            }
            rows
        };

        for (app_type, config_path, enabled) in rows {
            let default_path = Self::default_integration_path(&app_type);
            let final_path = match config_path {
                Some(path) if !path.trim().is_empty() => Some(path),
                _ => default_path,
            };
            let detected = Self::detect_integration(&app_type, final_path.as_deref());
            let _ = self.conn.execute(
                "UPDATE app_integrations
                 SET detected = ?1, config_path = ?2, updated_at = ?3, enabled = ?4
                 WHERE app_type = ?5",
                params![
                    bool_to_int(detected),
                    final_path,
                    Local::now().to_rfc3339(),
                    enabled,
                    app_type
                ],
            );
        }
    }

    fn get_app_integrations(&self) -> Result<Vec<AppIntegration>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, app_type, detected, enabled, config_path, updated_at
                 FROM app_integrations
                 ORDER BY app_type ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AppIntegration {
                    id: row.get(0)?,
                    app_type: row.get(1)?,
                    detected: int_to_bool(row.get(2)?),
                    enabled: int_to_bool(row.get(3)?),
                    config_path: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        let has_claude_code = items.iter().any(|item| item.app_type == "claude-code");
        if has_claude_code {
            items.retain(|item| item.app_type != "claude");
        }
        Ok(items)
    }

    fn get_integration_path(&self, app_type: &str) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT config_path FROM app_integrations WHERE app_type = ?1")
            .map_err(|e| e.to_string())?;
        let path = stmt
            .query_row(params![app_type], |row| row.get::<_, Option<String>>(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        Ok(path)
    }

    fn get_service_configs(&self) -> Result<Vec<ServiceConfig>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT service_name, enabled, auto_start, port, updated_at
                 FROM service_runtime
                 ORDER BY service_name ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let service_name: String = row.get(0)?;
                let enabled = int_to_bool(row.get::<_, i64>(1)?);
                let auto_start = int_to_bool(row.get::<_, i64>(2)?);
                let port: Option<i64> = row.get(3)?;
                let running = Self::is_service_running(&service_name, enabled, port);
                let health = if !enabled {
                    "disabled".to_string()
                } else if running {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                };
                Ok(ServiceConfig {
                    service_name,
                    enabled,
                    auto_start,
                    port,
                    running,
                    health,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut services = Vec::new();
        for row in rows {
            services.push(row.map_err(|e| e.to_string())?);
        }
        Ok(services)
    }

    fn is_service_running(service_name: &str, enabled: bool, port: Option<i64>) -> bool {
        if !enabled {
            return false;
        }
        match service_name {
            "gateway" => {
                let port = match port {
                    Some(value) if (1..=65535).contains(&value) => value as u16,
                    _ => return false,
                };
                let address: SocketAddr = SocketAddr::from(([127, 0, 0, 1], port));
                TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
            }
            "usage-probe" => true,
            _ => false,
        }
    }

    fn integration_fallback_paths(app_type: &str) -> Vec<PathBuf> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };

        match app_type {
            "claude" | "claude-code" => vec![
                home.join(".claude").join("settings.json"),
                home.join(".claude.json"),
            ],
            "codex" => vec![
                home.join(".codex").join("config.toml"),
                home.join(".codex").join("auth.json"),
            ],
            "gemini" => vec![home.join(".gemini").join("settings.json")],
            "github" => vec![
                home.join(".config").join("github-copilot"),
                home.join(".copilot"),
            ],
            "antigravity" => vec![
                home.join(".config").join("antigravity"),
                home.join(".antigravity"),
            ],
            "z.ai" => vec![
                home.join(".claude").join("settings.json"),
                home.join(".claude.json"),
                home.join(".zai"),
            ],
            "amp" => vec![home.join(".config").join("amp"), home.join(".amp")],
            "aws" => vec![
                home.join(".aws").join("config"),
                home.join(".aws").join("credentials"),
            ],
            "cursor" => vec![home.join(".cursor")],
            "opencode" => vec![
                home.join(".config").join("opencode").join("opencode.json"),
                home.join(".opencode").join("opencode.json"),
                home.join(".opencode").join("config.json"),
            ],
            "openclaw" => vec![
                home.join(".openclaw").join("openclaw.json"),
                home.join(".config").join("openclaw").join("openclaw.json"),
                home.join(".openclaw").join("config.json"),
                home.join(".config").join("openclaw").join("config.json"),
            ],
            _ => Vec::new(),
        }
    }

    fn default_integration_path(app_type: &str) -> Option<String> {
        let home = dirs::home_dir()?;
        let path = match app_type {
            "claude" => home.join(".claude").join("settings.json"),
            "claude-code" => home.join(".claude.json"),
            "codex" => home.join(".codex").join("config.toml"),
            "gemini" => home.join(".gemini").join("settings.json"),
            "github" => home.join(".config").join("github-copilot"),
            "antigravity" => home.join(".config").join("antigravity"),
            "z.ai" => home.join(".claude.json"),
            "amp" => home.join(".config").join("amp"),
            "aws" => home.join(".aws").join("config"),
            "cursor" => home.join(".cursor"),
            "opencode" => home.join(".config").join("opencode").join("opencode.json"),
            "openclaw" => home.join(".openclaw").join("openclaw.json"),
            _ => return None,
        };
        Some(path.to_string_lossy().to_string())
    }

    fn detect_integration(app_type: &str, config_path: Option<&str>) -> bool {
        if app_type == "openai-compatible" {
            return true;
        }
        if let Some(path) = config_path {
            let trimmed = path.trim();
            if !trimmed.is_empty() && Path::new(trimmed).exists() {
                return true;
            }
        }
        Self::integration_fallback_paths(app_type)
            .iter()
            .any(|path| path.exists())
    }

    fn meta_get(&self, key: &str) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM meta WHERE key = ?1")
            .map_err(|e| e.to_string())?;
        let value = stmt
            .query_row(params![key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(value)
    }

    fn meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn load_master_password(conn: &Connection) -> Result<Option<String>, String> {
        let mut stmt = conn
            .prepare("SELECT value FROM meta WHERE key = 'master_password_hash'")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let value: String = row.get(0).map_err(|e| e.to_string())?;
            return Ok(Some(value));
        }
        Ok(None)
    }

    fn load_credentials(conn: &Connection) -> Result<HashMap<String, Credential>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider, name, secret_key, created_at, is_active, source FROM credentials",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Credential {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    name: row.get(2)?,
                    key: row.get(3)?,
                    created_at: row.get(4)?,
                    is_active: int_to_bool(row.get(5)?),
                    source: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map = HashMap::new();
        for item in rows {
            let cred = item.map_err(|e| e.to_string())?;
            map.insert(cred.id.clone(), cred);
        }
        Ok(map)
    }

    fn load_providers(conn: &Connection) -> Result<HashMap<String, ProviderConfig>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT provider, label, api_key, base_url, updated_at, is_active, models FROM providers",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let models_raw: String = row.get(6)?;
                let models: Vec<String> = serde_json::from_str(&models_raw).unwrap_or_default();
                Ok(ProviderConfig {
                    provider: row.get(0)?,
                    label: row.get(1)?,
                    api_key: row.get(2)?,
                    base_url: row.get(3)?,
                    updated_at: row.get(4)?,
                    is_active: int_to_bool(row.get(5)?),
                    models,
                    endpoints: Vec::new(),
                    env_vars: Vec::new(),
                    app_bindings: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map = HashMap::new();
        for item in rows {
            let provider = item.map_err(|e| e.to_string())?;
            map.insert(provider.provider.clone(), provider);
        }
        Ok(map)
    }

    fn load_prompts(conn: &Connection) -> Result<HashMap<String, PromptTemplate>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, content, model, variables, created_at, updated_at FROM prompts",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let vars_raw: String = row.get(4)?;
                let variables: Vec<String> = serde_json::from_str(&vars_raw).unwrap_or_default();
                Ok(PromptTemplate {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    model: row.get(3)?,
                    variables,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map = HashMap::new();
        for item in rows {
            let prompt = item.map_err(|e| e.to_string())?;
            map.insert(prompt.id.clone(), prompt);
        }
        Ok(map)
    }

    fn load_provider_endpoints(
        conn: &Connection,
    ) -> Result<HashMap<String, Vec<ProviderEndpoint>>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider, base_url, headers, timeout_ms, proxy_url, is_primary, created_at, updated_at FROM provider_endpoints",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProviderEndpoint {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    base_url: row.get(2)?,
                    headers: row.get(3)?,
                    timeout_ms: row.get(4)?,
                    proxy_url: row.get(5)?,
                    is_primary: int_to_bool(row.get(6)?),
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map: HashMap<String, Vec<ProviderEndpoint>> = HashMap::new();
        for item in rows {
            let endpoint = item.map_err(|e| e.to_string())?;
            map.entry(endpoint.provider.clone())
                .or_default()
                .push(endpoint);
        }
        Ok(map)
    }

    fn load_provider_models(
        conn: &Connection,
    ) -> Result<HashMap<String, Vec<ProviderModel>>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider, name, alias, context_window, input_price, output_price, created_at, updated_at FROM provider_models",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProviderModel {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    name: row.get(2)?,
                    alias: row.get(3)?,
                    context_window: row.get(4)?,
                    input_price: row.get(5)?,
                    output_price: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map: HashMap<String, Vec<ProviderModel>> = HashMap::new();
        for item in rows {
            let model = item.map_err(|e| e.to_string())?;
            map.entry(model.provider.clone()).or_default().push(model);
        }
        Ok(map)
    }

    fn load_provider_env_vars(
        conn: &Connection,
    ) -> Result<HashMap<String, Vec<ProviderEnvVar>>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider, key, value, is_secret, created_at, updated_at FROM provider_env_vars",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProviderEnvVar {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    key: row.get(2)?,
                    value: row.get(3)?,
                    is_secret: int_to_bool(row.get(4)?),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map: HashMap<String, Vec<ProviderEnvVar>> = HashMap::new();
        for item in rows {
            let env_var = item.map_err(|e| e.to_string())?;
            map.entry(env_var.provider.clone())
                .or_default()
                .push(env_var);
        }
        Ok(map)
    }

    fn load_provider_app_bindings(
        conn: &Connection,
    ) -> Result<HashMap<String, Vec<ProviderAppBinding>>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider, app_type, config_path, enabled, created_at, updated_at FROM provider_apps",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProviderAppBinding {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    app_type: row.get(2)?,
                    config_path: row.get(3)?,
                    enabled: int_to_bool(row.get(4)?),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut map: HashMap<String, Vec<ProviderAppBinding>> = HashMap::new();
        for item in rows {
            let binding = item.map_err(|e| e.to_string())?;
            map.entry(binding.provider.clone())
                .or_default()
                .push(binding);
        }
        Ok(map)
    }

    fn ensure_default_providers(&mut self) {
        let templates = provider_defaults::default_templates();
        for template in templates {
            let key = template.provider.to_string();
            if !self.providers.contains_key(&key) {
                let provider_config = provider_defaults::template_to_provider_config(&template);
                let models_json = serde_json::to_string(&provider_config.models)
                    .unwrap_or_else(|_| "[]".to_string());
                if self
                    .conn
                    .execute(
                        "INSERT INTO providers (provider, label, api_key, base_url, updated_at, is_active, models) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            provider_config.provider,
                            provider_config.label,
                            provider_config.api_key,
                            provider_config.base_url,
                            provider_config.updated_at,
                            bool_to_int(provider_config.is_active),
                            models_json,
                        ],
                    )
                    .is_ok()
                {
                    self.providers.insert(key.clone(), provider_config);
                }
            }

            self.ensure_provider_defaults(&key, &template);
        }
    }

    fn is_builtin_provider(provider: &str) -> bool {
        provider_defaults::default_templates()
            .iter()
            .any(|template| template.provider == provider)
    }

    fn ensure_provider_defaults(
        &mut self,
        provider: &str,
        template: &provider_defaults::ProviderTemplate,
    ) {
        if let Some(config) = self.providers.get_mut(provider) {
            if config.models.is_empty() && !template.models.is_empty() {
                config.models = template
                    .models
                    .iter()
                    .map(|model| (*model).to_string())
                    .collect();
                let models_json =
                    serde_json::to_string(&config.models).unwrap_or_else(|_| "[]".to_string());
                let _ = self.conn.execute(
                    "UPDATE providers SET models = ?1 WHERE provider = ?2",
                    params![models_json, provider],
                );
            }
        }

        if self
            .provider_endpoints
            .get(provider)
            .map(|items| items.is_empty())
            .unwrap_or(true)
        {
            let endpoints = provider_defaults::template_to_endpoints(template);
            for endpoint in &endpoints {
                let _ = self.conn.execute(
                    "INSERT INTO provider_endpoints (id, provider, base_url, headers, timeout_ms, proxy_url, is_primary, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        endpoint.id,
                        endpoint.provider,
                        endpoint.base_url,
                        endpoint.headers,
                        endpoint.timeout_ms,
                        endpoint.proxy_url,
                        bool_to_int(endpoint.is_primary),
                        endpoint.created_at,
                        endpoint.updated_at,
                    ],
                );
            }
            self.provider_endpoints
                .insert(provider.to_string(), endpoints);
        }

        if self
            .provider_models
            .get(provider)
            .map(|items| items.is_empty())
            .unwrap_or(true)
        {
            let models = provider_defaults::template_to_models(template);
            for model in &models {
                let _ = self.conn.execute(
                    "INSERT INTO provider_models (id, provider, name, alias, context_window, input_price, output_price, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        model.id,
                        model.provider,
                        model.name,
                        model.alias,
                        model.context_window,
                        model.input_price,
                        model.output_price,
                        model.created_at,
                        model.updated_at,
                    ],
                );
            }
            self.provider_models.insert(provider.to_string(), models);
        }

        if self
            .provider_env_vars
            .get(provider)
            .map(|items| items.is_empty())
            .unwrap_or(true)
        {
            let env_vars = provider_defaults::template_to_env_vars(template);
            for env_var in &env_vars {
                let _ = self.conn.execute(
                    "INSERT INTO provider_env_vars (id, provider, key, value, is_secret, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        env_var.id,
                        env_var.provider,
                        env_var.key,
                        env_var.value,
                        bool_to_int(env_var.is_secret),
                        env_var.created_at,
                        env_var.updated_at,
                    ],
                );
            }
            self.provider_env_vars
                .insert(provider.to_string(), env_vars);
        }

        let has_existing_bindings = self.provider_app_bindings.contains_key(provider);
        let mut bindings = self
            .provider_app_bindings
            .get(provider)
            .cloned()
            .unwrap_or_default();
        let mut existing_types: HashSet<String> = bindings
            .iter()
            .map(|item| item.app_type.trim().to_ascii_lowercase())
            .collect();
        let mut inserted_any = false;

        for binding in provider_defaults::template_to_app_bindings(template) {
            let app_type_key = binding.app_type.trim().to_ascii_lowercase();
            if app_type_key.is_empty() || existing_types.contains(&app_type_key) {
                continue;
            }
            let _ = self.conn.execute(
                "INSERT INTO provider_apps (id, provider, app_type, config_path, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    binding.id,
                    binding.provider,
                    binding.app_type,
                    binding.config_path,
                    bool_to_int(binding.enabled),
                    binding.created_at,
                    binding.updated_at,
                ],
            );
            existing_types.insert(app_type_key);
            bindings.push(binding);
            inserted_any = true;
        }

        if inserted_any || !has_existing_bindings {
            self.provider_app_bindings
                .insert(provider.to_string(), bindings);
        }
    }

    pub fn add_project(
        &mut self,
        name: String,
        path: String,
        credential_id: Option<String>,
    ) -> Result<crate::Project, String> {
        let id = Uuid::new_v4().to_string();
        let now = Local::now().to_rfc3339();

        // Verify credential exists if provided
        if let Some(ref cred_id) = credential_id {
            if !self.credentials.contains_key(cred_id) {
                return Err("Credential not found".to_string());
            }
        }

        self.conn
            .execute(
                "INSERT INTO projects (id, name, path, credential_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, name, path, credential_id, now, now],
            )
            .map_err(|e| e.to_string())?;

        Ok(crate::Project {
            id,
            name,
            path,
            credential_id,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get_projects(&self) -> Result<Vec<crate::Project>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, path, credential_id, created_at, updated_at FROM projects ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let projects = stmt
            .query_map([], |row| {
                Ok(crate::Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    credential_id: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut result = Vec::new();
        for project in projects {
            result.push(project.map_err(|e| e.to_string())?);
        }
        Ok(result)
    }

    pub fn update_project(
        &mut self,
        id: String,
        name: String,
        path: String,
        credential_id: Option<String>,
    ) -> Result<crate::Project, String> {
        let now = Local::now().to_rfc3339();

        if let Some(ref cred_id) = credential_id {
            if !self.credentials.contains_key(cred_id) {
                return Err("Credential not found".to_string());
            }
        }

        let count = self.conn.execute(
            "UPDATE projects SET name = ?1, path = ?2, credential_id = ?3, updated_at = ?4 WHERE id = ?5",
            params![name, path, credential_id, now, id],
        ).map_err(|e| e.to_string())?;

        if count == 0 {
            return Err("Project not found".to_string());
        }

        // Fetch creation time to return full object
        let created_at: String = self
            .conn
            .query_row(
                "SELECT created_at FROM projects WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        Ok(crate::Project {
            id,
            name,
            path,
            credential_id,
            created_at,
            updated_at: now,
        })
    }

    pub fn delete_project(&mut self, id: &str) -> Result<(), String> {
        let count = self
            .conn
            .execute("DELETE FROM projects WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        if count == 0 {
            return Err("Project not found".to_string());
        }
        Ok(())
    }
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

fn project_label_secret_id(credential_id: &str) -> String {
    format!("project-label:{credential_id}")
}

fn mask_key(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let len = trimmed.chars().count();
    if len <= 8 {
        return "******".to_string();
    }
    let prefix: String = trimmed.chars().take(4).collect();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{}...{}", prefix, suffix)
}
