use app_lib::vault_crypto::{
    add_passkey_prf_unlock_method, create_vault_header, decrypt_secret, encrypt_secret,
    generate_passkey_prf_salt, unlock_vault_key, PasskeyPrfDescriptor, VaultUnlockRequest,
};

#[test]
fn master_password_wraps_and_unlocks_vault_key_without_exposing_secret_plaintext() {
    let (header, recovery_key) = create_vault_header("correct horse battery staple").unwrap();

    let vault_key = unlock_vault_key(
        &header,
        VaultUnlockRequest::MasterPassword("correct horse battery staple"),
    )
    .unwrap();
    let sealed = encrypt_secret(&vault_key, b"openai-secret-key", b"credential:test").unwrap();

    assert_ne!(sealed.ciphertext, "openai-secret-key");
    assert_eq!(
        decrypt_secret(&vault_key, &sealed, b"credential:test").unwrap(),
        b"openai-secret-key"
    );
    assert!(unlock_vault_key(
        &header,
        VaultUnlockRequest::MasterPassword("wrong password")
    )
    .is_err());
    assert!(
        unlock_vault_key(&header, VaultUnlockRequest::RecoveryKey(&recovery_key)).is_ok(),
        "the generated recovery key should be a separate unlock path"
    );
}

#[test]
fn passkey_prf_can_be_added_as_a_second_unlock_method_for_the_same_vault_key() {
    let (mut header, _recovery_key) = create_vault_header("master password").unwrap();
    let vault_key = unlock_vault_key(
        &header,
        VaultUnlockRequest::MasterPassword("master password"),
    )
    .unwrap();
    let prf_key = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    let prf_salt = generate_passkey_prf_salt();

    add_passkey_prf_unlock_method(
        &mut header,
        &vault_key,
        PasskeyPrfDescriptor {
            rp_id: "mykey.local".to_string(),
            user_id: "user-1".to_string(),
            credential_id: "credential-1".to_string(),
            prf_salt,
            prf_key_hex: prf_key.to_string(),
        },
    )
    .unwrap();

    let passkey_vault_key =
        unlock_vault_key(&header, VaultUnlockRequest::PasskeyPrfKeyHex(prf_key)).unwrap();

    assert_eq!(passkey_vault_key, vault_key);
    assert!(unlock_vault_key(
        &header,
        VaultUnlockRequest::PasskeyPrfKeyHex(
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        )
    )
    .is_err());
}

#[test]
fn recovery_key_is_high_entropy_and_can_unlock_after_master_password_is_lost() {
    let (header, recovery_key) = create_vault_header("temporary master password").unwrap();

    assert!(recovery_key.starts_with("MYKEY-"));
    assert!(recovery_key.len() >= 40);

    let recovered =
        unlock_vault_key(&header, VaultUnlockRequest::RecoveryKey(&recovery_key)).unwrap();
    let sealed =
        encrypt_secret(&recovered, b"anthropic-secret-key", b"credential:recovered").unwrap();

    assert_eq!(
        decrypt_secret(&recovered, &sealed, b"credential:recovered").unwrap(),
        b"anthropic-secret-key"
    );
    assert!(unlock_vault_key(&header, VaultUnlockRequest::RecoveryKey("MYKEY-wrong")).is_err());
}
