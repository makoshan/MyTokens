use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

const VAULT_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultKey([u8; VAULT_KEY_LEN]);

impl VaultKey {
    fn random() -> Self {
        let mut key = [0u8; VAULT_KEY_LEN];
        OsRng.fill_bytes(&mut key);
        Self(key)
    }

    fn as_bytes(&self) -> &[u8; VAULT_KEY_LEN] {
        &self.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHeader {
    pub version: u32,
    pub vault_id: String,
    pub cipher: String,
    pub unlock_methods: Vec<VaultUnlockMethod>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VaultUnlockMethod {
    MasterPassword {
        kdf: String,
        salt: String,
        encrypted_vault_key: SealedVaultKey,
    },
    PasskeyPrf {
        rp_id: String,
        user_id: String,
        credential_id: String,
        prf_salt: String,
        encrypted_vault_key: SealedVaultKey,
    },
    RecoveryKey {
        recovery_key_id: String,
        salt: String,
        encrypted_vault_key: SealedVaultKey,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedVaultKey {
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedSecret {
    pub cipher: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug)]
pub struct PasskeyPrfDescriptor {
    pub rp_id: String,
    pub user_id: String,
    pub credential_id: String,
    pub prf_salt: String,
    pub prf_key_hex: String,
}

#[derive(Clone, Copy, Debug)]
pub enum VaultUnlockRequest<'a> {
    MasterPassword(&'a str),
    PasskeyPrfKeyHex(&'a str),
    RecoveryKey(&'a str),
}

pub fn create_vault_header(master_password: &str) -> Result<(VaultHeader, String), String> {
    if master_password.is_empty() {
        return Err("Master password is required".to_string());
    }

    let vault_key = VaultKey::random();
    let recovery_key = generate_recovery_key();
    let master_salt = random_bytes(SALT_LEN);
    let recovery_salt = random_bytes(SALT_LEN);

    let master_kek = derive_master_password_kek(master_password, &master_salt)?;
    let recovery_kek = derive_recovery_kek(&recovery_key, &recovery_salt)?;

    let header = VaultHeader {
        version: 1,
        vault_id: Uuid::new_v4().to_string(),
        cipher: "aes-256-gcm".to_string(),
        unlock_methods: vec![
            VaultUnlockMethod::MasterPassword {
                kdf: "argon2id".to_string(),
                salt: encode_b64(&master_salt),
                encrypted_vault_key: seal_vault_key(&vault_key, &master_kek)?,
            },
            VaultUnlockMethod::RecoveryKey {
                recovery_key_id: Uuid::new_v4().to_string(),
                salt: encode_b64(&recovery_salt),
                encrypted_vault_key: seal_vault_key(&vault_key, &recovery_kek)?,
            },
        ],
    };

    Ok((header, recovery_key))
}

pub fn generate_passkey_prf_salt() -> String {
    encode_b64(&random_bytes(SALT_LEN))
}

pub fn add_passkey_prf_unlock_method(
    header: &mut VaultHeader,
    vault_key: &VaultKey,
    descriptor: PasskeyPrfDescriptor,
) -> Result<(), String> {
    let prf_key = decode_hex_32(&descriptor.prf_key_hex)?;
    let prf_salt = decode_b64(&descriptor.prf_salt)?;
    let kek = derive_passkey_prf_kek(&prf_key, &prf_salt)?;
    let encrypted_vault_key = seal_vault_key(vault_key, &kek)?;

    header.unlock_methods.push(VaultUnlockMethod::PasskeyPrf {
        rp_id: descriptor.rp_id,
        user_id: descriptor.user_id,
        credential_id: descriptor.credential_id,
        prf_salt: descriptor.prf_salt,
        encrypted_vault_key,
    });
    Ok(())
}

pub fn unlock_vault_key(
    header: &VaultHeader,
    request: VaultUnlockRequest<'_>,
) -> Result<VaultKey, String> {
    for method in &header.unlock_methods {
        let attempt = match (method, request) {
            (
                VaultUnlockMethod::MasterPassword {
                    salt,
                    encrypted_vault_key,
                    ..
                },
                VaultUnlockRequest::MasterPassword(password),
            ) => {
                let salt = decode_b64(salt)?;
                let kek = derive_master_password_kek(password, &salt)?;
                open_vault_key(encrypted_vault_key, &kek)
            }
            (
                VaultUnlockMethod::PasskeyPrf {
                    prf_salt,
                    encrypted_vault_key,
                    ..
                },
                VaultUnlockRequest::PasskeyPrfKeyHex(prf_key_hex),
            ) => {
                let prf_key = decode_hex_32(prf_key_hex)?;
                let salt = decode_b64(prf_salt)?;
                let kek = derive_passkey_prf_kek(&prf_key, &salt)?;
                open_vault_key(encrypted_vault_key, &kek)
            }
            (
                VaultUnlockMethod::RecoveryKey {
                    salt,
                    encrypted_vault_key,
                    ..
                },
                VaultUnlockRequest::RecoveryKey(recovery_key),
            ) => {
                let salt = decode_b64(salt)?;
                let kek = derive_recovery_kek(recovery_key, &salt)?;
                open_vault_key(encrypted_vault_key, &kek)
            }
            _ => continue,
        };

        if attempt.is_ok() {
            return attempt;
        }
    }

    Err("No unlock method accepted the supplied secret".to_string())
}

pub fn encrypt_secret(
    vault_key: &VaultKey,
    plaintext: &[u8],
    associated_data: &[u8],
) -> Result<SealedSecret, String> {
    let nonce = random_bytes(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(vault_key.as_bytes()).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: plaintext,
                aad: associated_data,
            },
        )
        .map_err(|_| "Failed to encrypt secret".to_string())?;

    Ok(SealedSecret {
        cipher: "aes-256-gcm".to_string(),
        nonce: encode_b64(&nonce),
        ciphertext: encode_b64(&ciphertext),
    })
}

pub fn decrypt_secret(
    vault_key: &VaultKey,
    sealed: &SealedSecret,
    associated_data: &[u8],
) -> Result<Vec<u8>, String> {
    if sealed.cipher != "aes-256-gcm" {
        return Err(format!("Unsupported cipher: {}", sealed.cipher));
    }

    let nonce = decode_b64(&sealed.nonce)?;
    let ciphertext = decode_b64(&sealed.ciphertext)?;
    let cipher = Aes256Gcm::new_from_slice(vault_key.as_bytes()).map_err(|e| e.to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &ciphertext,
                aad: associated_data,
            },
        )
        .map_err(|_| "Failed to decrypt secret".to_string())
}

fn seal_vault_key(
    vault_key: &VaultKey,
    kek: &[u8; VAULT_KEY_LEN],
) -> Result<SealedVaultKey, String> {
    let nonce = random_bytes(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(kek).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), vault_key.as_bytes().as_slice())
        .map_err(|_| "Failed to seal vault key".to_string())?;
    Ok(SealedVaultKey {
        nonce: encode_b64(&nonce),
        ciphertext: encode_b64(&ciphertext),
    })
}

fn open_vault_key(sealed: &SealedVaultKey, kek: &[u8; VAULT_KEY_LEN]) -> Result<VaultKey, String> {
    let nonce = decode_b64(&sealed.nonce)?;
    let ciphertext = decode_b64(&sealed.ciphertext)?;
    let cipher = Aes256Gcm::new_from_slice(kek).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|_| "Failed to unlock vault key".to_string())?;
    let bytes: [u8; VAULT_KEY_LEN] = plaintext
        .try_into()
        .map_err(|_| "Unlocked vault key has invalid length".to_string())?;
    Ok(VaultKey(bytes))
}

fn derive_master_password_kek(password: &str, salt: &[u8]) -> Result<[u8; VAULT_KEY_LEN], String> {
    let mut output = [0u8; VAULT_KEY_LEN];
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(VAULT_KEY_LEN),
    )
    .map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut output)
        .map_err(|e| format!("Failed to derive master password key: {e}"))?;
    Ok(output)
}

fn derive_passkey_prf_kek(
    prf_key: &[u8; VAULT_KEY_LEN],
    salt: &[u8],
) -> Result<[u8; VAULT_KEY_LEN], String> {
    hkdf_expand(prf_key, salt, b"mykey passkey prf vault key wrap v1")
}

fn derive_recovery_kek(recovery_key: &str, salt: &[u8]) -> Result<[u8; VAULT_KEY_LEN], String> {
    hkdf_expand(
        recovery_key.as_bytes(),
        salt,
        b"mykey recovery vault key wrap v1",
    )
}

fn hkdf_expand(ikm: &[u8], salt: &[u8], info: &[u8]) -> Result<[u8; VAULT_KEY_LEN], String> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut output = [0u8; VAULT_KEY_LEN];
    hk.expand(info, &mut output)
        .map_err(|_| "Failed to derive key material".to_string())?;
    Ok(output)
}

fn generate_recovery_key() -> String {
    let mut bytes = [0u8; 20];
    OsRng.fill_bytes(&mut bytes);
    let encoded = encode_base32_no_padding(&bytes);
    let groups = encoded
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-");
    format!("MYKEY-{groups}")
}

fn encode_base32_no_padding(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let mut buffer = 0u16;
    let mut bits_left = 0u8;

    for byte in bytes {
        buffer = (buffer << 8) | u16::from(*byte);
        bits_left += 8;
        while bits_left >= 5 {
            let index = ((buffer >> (bits_left - 5)) & 0b11111) as usize;
            out.push(ALPHABET[index] as char);
            bits_left -= 5;
        }
    }

    if bits_left > 0 {
        let index = ((buffer << (5 - bits_left)) & 0b11111) as usize;
        out.push(ALPHABET[index] as char);
    }

    out
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn encode_b64(bytes: &[u8]) -> String {
    STANDARD_NO_PAD.encode(bytes)
}

fn decode_b64(value: &str) -> Result<Vec<u8>, String> {
    STANDARD_NO_PAD
        .decode(value)
        .map_err(|e| format!("Invalid base64 value: {e}"))
}

fn decode_hex_32(value: &str) -> Result<[u8; VAULT_KEY_LEN], String> {
    if value.len() != VAULT_KEY_LEN * 2 {
        return Err("PRF key must be 32 bytes encoded as hex".to_string());
    }

    let mut out = [0u8; VAULT_KEY_LEN];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let hex = std::str::from_utf8(chunk).map_err(|_| "Invalid hex key".to_string())?;
        out[index] = u8::from_str_radix(hex, 16).map_err(|_| "Invalid hex key".to_string())?;
    }
    Ok(out)
}
