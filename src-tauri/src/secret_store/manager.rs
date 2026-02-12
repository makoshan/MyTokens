use std::sync::{Arc, Mutex};

use crate::secret_store::config::{SecretStoreConfig, SecretStoreProviderConfig};
use crate::secret_store::provider::{Secret, SecretProvider, SecretStoreError};
use crate::secret_store::providers::{KeyringProvider, MemoryProvider, SqliteProvider};

#[derive(Debug)]
pub struct SecretManager {
    providers: Vec<(String, Arc<Mutex<Box<dyn SecretProvider>>>)>,
    primary: String,
}

impl SecretManager {
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
            primary: String::new(),
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
        if !self.primary.is_empty()
            && self
                .providers
                .iter()
                .any(|(name, _)| name == &self.primary)
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
                Ok(secret) => return Ok(secret),
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
        guard.set(key_id, secret)
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
