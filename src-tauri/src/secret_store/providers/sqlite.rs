use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::secret_store::{Secret, SecretMetadata, SecretProvider, SecretStoreError};

#[derive(Debug)]
pub struct SqliteProvider {
    name: String,
    conn: Mutex<Connection>,
    db_path: PathBuf,
}

impl SqliteProvider {
    pub fn new(name: impl Into<String>, path: impl AsRef<Path>) -> Result<Self, SecretStoreError> {
        let db_path = path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| SecretStoreError::ProviderError("sqlite".to_string(), e.to_string()))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS secrets (
                key_id TEXT PRIMARY KEY,
                secret TEXT NOT NULL,
                created_at INTEGER,
                updated_at INTEGER,
                tags TEXT,
                note TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_secrets_updated_at ON secrets(updated_at);",
        )
        .map_err(|e| SecretStoreError::ProviderError("sqlite".to_string(), e.to_string()))?;

        Ok(Self {
            name: name.into(),
            conn: Mutex::new(conn),
            db_path,
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretProvider for SqliteProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn provider_type(&self) -> &str {
        "sqlite"
    }

    fn get(&self, key_id: &str) -> Result<Secret, SecretStoreError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT secret, created_at, updated_at, tags, note FROM secrets WHERE key_id = ?1",
            )
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        let row = stmt
            .query_row(params![key_id], |row| {
                let tags: Option<String> = row.get(3)?;
                Ok(Secret {
                    value: row.get(0)?,
                    metadata: SecretMetadata {
                        provider: self.name.clone(),
                        created_at: row.get(1)?,
                        updated_at: row.get(2)?,
                        tags: tags
                            .map(|value| value.split(',').map(|s| s.to_string()).collect())
                            .unwrap_or_default(),
                        note: row.get(4)?,
                    },
                })
            })
            .map_err(|e| {
                if e == rusqlite::Error::QueryReturnedNoRows {
                    SecretStoreError::NotFound(key_id.to_string())
                } else {
                    SecretStoreError::ProviderError(self.name.clone(), e.to_string())
                }
            })?;
        Ok(row)
    }

    fn set(&self, key_id: &str, secret: &Secret) -> Result<(), SecretStoreError> {
        let now = chrono::Utc::now().timestamp();
        let created_at = secret.metadata.created_at.unwrap_or(now);
        let tags = if secret.metadata.tags.is_empty() {
            None
        } else {
            Some(secret.metadata.tags.join(","))
        };

        self.conn()
            .execute(
                "INSERT INTO secrets (key_id, secret, created_at, updated_at, tags, note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(key_id) DO UPDATE SET
                   secret = excluded.secret,
                   updated_at = excluded.updated_at,
                   tags = excluded.tags,
                   note = excluded.note",
                params![
                    key_id,
                    secret.value,
                    created_at,
                    now,
                    tags,
                    secret.metadata.note,
                ],
            )
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        Ok(())
    }

    fn delete(&self, key_id: &str) -> Result<(), SecretStoreError> {
        let affected = self
            .conn()
            .execute("DELETE FROM secrets WHERE key_id = ?1", params![key_id])
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        if affected == 0 {
            return Err(SecretStoreError::NotFound(key_id.to_string()));
        }
        Ok(())
    }

    fn list(&self) -> Result<Vec<String>, SecretStoreError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT key_id FROM secrets")
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        let mut items = Vec::new();
        for row in rows {
            items.push(
                row.map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?,
            );
        }
        Ok(items)
    }

    fn exists(&self, key_id: &str) -> Result<bool, SecretStoreError> {
        let count: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM secrets WHERE key_id = ?1",
                params![key_id],
                |row| row.get(0),
            )
            .map_err(|e| SecretStoreError::ProviderError(self.name.clone(), e.to_string()))?;
        Ok(count > 0)
    }
}
