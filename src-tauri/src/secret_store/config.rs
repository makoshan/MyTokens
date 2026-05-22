use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecretStoreConfig {
    pub primary: String,
    #[serde(default)]
    pub providers: Vec<SecretStoreProviderConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecretStoreProviderConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub config: HashMap<String, toml::Value>,
    #[serde(default)]
    pub priority: i32,
}

impl SecretStoreConfig {
    pub fn default_with_path(db_path: &Path) -> Self {
        let mut config = HashMap::new();
        config.insert(
            "path".to_string(),
            toml::Value::String(db_path.to_string_lossy().to_string()),
        );

        Self {
            primary: "local".to_string(),
            providers: vec![SecretStoreProviderConfig {
                name: "local".to_string(),
                kind: "sqlite".to_string(),
                config,
                priority: 0,
            }],
        }
    }
}
