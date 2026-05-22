use std::sync::{Arc, Mutex};

use crate::secret_store::config::{SecretStoreConfig, SecretStoreProviderConfig};
use crate::secret_store::provider::{Secret, SecretProvider, SecretStoreError};
use crate::secret_store::providers::{KeyringProvider, MemoryProvider, SqliteProvider};
use crate::vault_crypto::{decrypt_secret, encrypt_secret, SealedSecret, VaultKey};

#[derive(Debug)]
pub struct SecretManager {
    providers: Vec<(String, Arc<Mutex<Box<dyn SecretProvider>>>)>,
    primary: String,
    // Data key unwrapped from the vault header on unlock. When present, secret
    // values are AES-256-GCM encrypted at rest in the local store instead of
    // relying on the OS keychain for at-rest protection.
    vault_key: Mutex<Option<VaultKey>>,
}

impl SecretManager {
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
            primary: String::new(),
            vault_key: Mutex::new(None),
        }
    }

    pub fn from_config(config: &SecretStoreConfig) -> Result<Self, SecretStoreError> {
        let mut manager = Self::new();

        let mut provider_configs = config.providers.clone();
        provider_configs.sort_by_key(|p| p.priority);

        for provider_config in provider_configs {
            let provider = Self::create_provider(&provider_config)?;
            manager.add_provider(provider_config.name.clone(), provider);
        }

        manager.primary = if config.primary.is_empty() {
            manager
                .providers
                .first()
                .map(|(name, _)| name.clone())
                .unwrap_or_default()
        } else {
            config.primary.clone()
        };

        Ok(manager)
    }

    fn create_provider(
        config: &SecretStoreProviderConfig,
    ) -> Result<Box<dyn SecretProvider>, SecretStoreError> {
        match config.kind.as_str() {
            "sqlite" => {
                let path = config
                    .config
                    .get("path")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        SecretStoreError::ConfigError("sqlite requires 'path'".to_string())
                    })?;
                let expanded = shellexpand::tilde(path).to_string();
                let provider = SqliteProvider::new(&config.name, &expanded)?;
                Ok(Box::new(provider))
            }
            "memory" => {
                let provider = MemoryProvider::new(&config.name);
                Ok(Box::new(provider))
            }
            "keyring" => {
                let service = config
                    .config
                    .get("service")
                    .and_then(|value| value.as_str())
                    .unwrap_or("MyKey");
                let provider = KeyringProvider::new(&config.name, service);
                Ok(Box::new(provider))
            }
            _ => Err(SecretStoreError::ConfigError(format!(
                "unknown provider type: {}",
                config.kind
            ))),
        }
    }

    pub fn add_provider(&mut self, name: impl Into<String>, provider: Box<dyn SecretProvider>) {
        self.providers
            .push((name.into(), Arc::new(Mutex::new(provider))));
    }

    pub fn set_primary(&mut self, name: impl Into<String>) {
        self.primary = name.into();
    }

    pub fn primary_name(&self) -> Option<&str> {
        if !self.primary.is_empty() && self.providers.iter().any(|(name, _)| name == &self.primary)
        {
            return Some(self.primary.as_str());
        }
        self.providers.first().map(|(name, _)| name.as_str())
    }

    pub fn get(&self, key_id: &str) -> Result<Secret, SecretStoreError> {
        for (_, provider) in &self.providers {
            let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            if !guard.is_unlocked() {
                continue;
            }
            match guard.get(key_id) {
                Ok(mut secret) => {
                    secret.value = self.open_value(key_id, &secret.value);
                    return Ok(secret);
                }
                Err(SecretStoreError::NotFound(_)) => continue,
                Err(_) => continue,
            }
        }

        Err(SecretStoreError::NotFound(key_id.to_string()))
    }

    pub fn set(&self, key_id: &str, secret: &Secret) -> Result<(), SecretStoreError> {
        let provider = self.primary_provider().ok_or_else(|| {
            SecretStoreError::ProviderError(
                "default".to_string(),
                "no primary provider".to_string(),
            )
        })?;
        let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.is_unlocked() {
            return Err(SecretStoreError::Locked(guard.name().to_string()));
        }
        let sealed = Secret {
            value: self.seal_value(key_id, &secret.value),
            metadata: secret.metadata.clone(),
        };
        guard.set(key_id, &sealed)
    }

    /// Hand the secret store the unwrapped vault data key so values are encrypted
    /// at rest. Called on unlock once the master password / passkey unwraps it.
    pub fn set_vault_key(&self, key: VaultKey) {
        *self.vault_key.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
    }

    fn seal_value(&self, key_id: &str, plaintext: &str) -> String {
        let guard = self.vault_key.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref key) = *guard {
            if let Ok(sealed) = encrypt_secret(key, plaintext.as_bytes(), key_id.as_bytes()) {
                if let Ok(json) = serde_json::to_string(&sealed) {
                    return json;
                }
            }
        }
        // No key yet (pre-unlock) or failure: store as-is; migrated on next unlock.
        plaintext.to_string()
    }

    fn open_value(&self, key_id: &str, stored: &str) -> String {
        // Only our envelope JSON is decrypted; anything else is legacy plaintext.
        let Ok(sealed) = serde_json::from_str::<SealedSecret>(stored) else {
            return stored.to_string();
        };
        let guard = self.vault_key.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref key) = *guard {
            if let Ok(plain) = decrypt_secret(key, &sealed, key_id.as_bytes()) {
                if let Ok(text) = String::from_utf8(plain) {
                    return text;
                }
            }
        }
        stored.to_string()
    }

    /// Re-encrypt any still-plaintext secrets once a vault key is available.
    /// Idempotent: values already stored as envelope JSON are skipped.
    pub fn migrate_plaintext_secrets(&self) {
        if self
            .vault_key
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none()
        {
            return;
        }
        let Some(provider) = self.primary_provider() else {
            return;
        };
        for key_id in self.list().unwrap_or_default() {
            let raw = {
                let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
                match guard.get(&key_id) {
                    Ok(secret) => secret,
                    Err(_) => continue,
                }
            };
            if serde_json::from_str::<SealedSecret>(&raw.value).is_ok() {
                continue; // already encrypted
            }
            let resealed = Secret {
                value: self.seal_value(&key_id, &raw.value),
                metadata: raw.metadata.clone(),
            };
            let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            let _ = guard.set(&key_id, &resealed);
        }
    }

    pub fn delete(&self, key_id: &str) -> Result<(), SecretStoreError> {
        let mut deleted = false;
        for (_, provider) in &self.providers {
            let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            if guard.delete(key_id).is_ok() {
                deleted = true;
            }
        }
        if deleted {
            Ok(())
        } else {
            Err(SecretStoreError::NotFound(key_id.to_string()))
        }
    }

    pub fn list(&self) -> Result<Vec<String>, SecretStoreError> {
        let mut keys = std::collections::HashSet::new();
        for (_, provider) in &self.providers {
            let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(items) = guard.list() {
                keys.extend(items);
            }
        }
        Ok(keys.into_iter().collect())
    }

    pub fn exists(&self, key_id: &str) -> Result<bool, SecretStoreError> {
        for (_, provider) in &self.providers {
            let guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(true) = guard.exists(key_id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn unlock_all(&self, password: &str) -> Result<(), SecretStoreError> {
        for (_, provider) in &self.providers {
            let mut guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            if !guard.is_unlocked() {
                let _ = guard.unlock(password);
            }
        }
        Ok(())
    }

    pub fn lock_all(&self) -> Result<(), SecretStoreError> {
        for (_, provider) in &self.providers {
            let mut guard = provider.lock().unwrap_or_else(|e| e.into_inner());
            let _ = guard.lock();
        }
        Ok(())
    }

    fn primary_provider(&self) -> Option<Arc<Mutex<Box<dyn SecretProvider>>>> {
        self.providers
            .iter()
            .find(|(name, _)| name == &self.primary)
            .map(|(_, provider)| provider.clone())
            .or_else(|| self.providers.first().map(|(_, provider)| provider.clone()))
    }
}
