use keyring::Entry;

use crate::secret_store::{Secret, SecretMetadata, SecretProvider, SecretStoreError};

#[derive(Debug)]
pub struct KeyringProvider {
    name: String,
    service: String,
}

impl KeyringProvider {
    pub fn new(name: impl Into<String>, service: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            service: service.into(),
        }
    }

    fn entry(&self, key_id: &str) -> Result<Entry, SecretStoreError> {
        Entry::new(&self.service, key_id)
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))
    }
}

impl SecretProvider for KeyringProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn provider_type(&self) -> &str {
        "keyring"
    }

    fn get(&self, key_id: &str) -> Result<Secret, SecretStoreError> {
        let entry = self.entry(key_id)?;
        let value = entry.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => SecretStoreError::NotFound(key_id.to_string()),
            _ => SecretStoreError::ProviderError(self.name.clone(), e.to_string()),
        })?;
        Ok(Secret {
            value,
            metadata: SecretMetadata {
                provider: self.name.clone(),
                ..Default::default()
            },
        })
    }

    fn set(&self, key_id: &str, secret: &Secret) -> Result<(), SecretStoreError> {
        let entry = self.entry(key_id)?;
        entry
            .set_password(&secret.value)
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        Ok(())
    }

    fn delete(&self, key_id: &str) -> Result<(), SecretStoreError> {
        let entry = self.entry(key_id)?;
        entry
            .delete_password()
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        Ok(())
    }

    fn list(&self) -> Result<Vec<String>, SecretStoreError> {
        Ok(vec![])
    }

    fn exists(&self, key_id: &str) -> Result<bool, SecretStoreError> {
        match self.get(key_id) {
            Ok(_) => Ok(true),
            Err(SecretStoreError::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
}
