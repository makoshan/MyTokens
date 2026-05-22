use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Clone)]
pub enum SecretStoreError {
    #[error("key not found: {0}")]
    NotFound(String),
    #[error("provider locked: {0}")]
    Locked(String),
    #[error("provider error [{0}]: {1}")]
    ProviderError(String, String),
    #[error("invalid configuration: {0}")]
    ConfigError(String),
    #[error("io error: {0}")]
    IoError(String),
}

impl From<std::io::Error> for SecretStoreError {
    fn from(err: std::io::Error) -> Self {
        SecretStoreError::IoError(err.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Secret {
    pub value: String,
    #[serde(default)]
    pub metadata: SecretMetadata,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SecretMetadata {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub trait SecretProvider: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &str;
    fn provider_type(&self) -> &str;

    fn get(&self, key_id: &str) -> Result<Secret, SecretStoreError>;
    fn set(&self, key_id: &str, secret: &Secret) -> Result<(), SecretStoreError>;
    fn delete(&self, key_id: &str) -> Result<(), SecretStoreError>;
    fn list(&self) -> Result<Vec<String>, SecretStoreError>;
    fn exists(&self, key_id: &str) -> Result<bool, SecretStoreError>;

    fn is_unlocked(&self) -> bool {
        true
    }

    fn unlock(&mut self, _password: &str) -> Result<(), SecretStoreError> {
        Ok(())
    }

    fn lock(&mut self) -> Result<(), SecretStoreError> {
        Ok(())
    }

    fn health(&self) -> Result<(), SecretStoreError> {
        Ok(())
    }
}
