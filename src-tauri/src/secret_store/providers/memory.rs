use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::secret_store::{Secret, SecretProvider, SecretStoreError};

#[derive(Debug)]
pub struct MemoryProvider {
    name: String,
    data: Mutex<HashMap<String, Secret>>,
    locked: Mutex<bool>,
}

impl MemoryProvider {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            data: Mutex::new(HashMap::new()),
            locked: Mutex::new(false),
        }
    }

    fn is_locked(&self) -> bool {
        *self.locked.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn data_guard(&self) -> MutexGuard<'_, HashMap<String, Secret>> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretProvider for MemoryProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn provider_type(&self) -> &str {
        "memory"
    }

    fn get(&self, key_id: &str) -> Result<Secret, SecretStoreError> {
        if self.is_locked() {
            return Err(SecretStoreError::Locked(self.name.clone()));
        }

        self.data_guard()
            .get(key_id)
            .cloned()
            .ok_or_else(|| SecretStoreError::NotFound(key_id.to_string()))
    }

    fn set(&self, key_id: &str, secret: &Secret) -> Result<(), SecretStoreError> {
        if self.is_locked() {
            return Err(SecretStoreError::Locked(self.name.clone()));
        }

        let mut secret = secret.clone();
        secret.metadata.provider = self.name.clone();
        secret.metadata.updated_at = Some(chrono::Utc::now().timestamp());

        self.data_guard().insert(key_id.to_string(), secret);
        Ok(())
    }

    fn delete(&self, key_id: &str) -> Result<(), SecretStoreError> {
        if self.is_locked() {
            return Err(SecretStoreError::Locked(self.name.clone()));
        }

        self.data_guard()
            .remove(key_id)
            .ok_or_else(|| SecretStoreError::NotFound(key_id.to_string()))?;
        Ok(())
    }

    fn list(&self) -> Result<Vec<String>, SecretStoreError> {
        Ok(self.data_guard().keys().cloned().collect())
    }

    fn exists(&self, key_id: &str) -> Result<bool, SecretStoreError> {
        Ok(self.data_guard().contains_key(key_id))
    }

    fn is_unlocked(&self) -> bool {
        !self.is_locked()
    }

    fn lock(&mut self) -> Result<(), SecretStoreError> {
        *self.locked.lock().unwrap_or_else(|e| e.into_inner()) = true;
        Ok(())
    }

    fn unlock(&mut self, _password: &str) -> Result<(), SecretStoreError> {
        *self.locked.lock().unwrap_or_else(|e| e.into_inner()) = false;
        Ok(())
    }
}
