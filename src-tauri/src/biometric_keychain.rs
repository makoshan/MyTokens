#[cfg(target_os = "macos")]
mod platform {
    use security_framework::base::{Error as SecError, Result as SecResult};
    use security_framework::item::{ItemClass, ItemSearchOptions};
    use security_framework::passwords::{delete_generic_password, get_generic_password};
    use security_framework::passwords_options::{AccessControlOptions, PasswordOptions};
    use security_framework_sys::base::{errSecItemNotFound, errSecSuccess};
    use security_framework_sys::keychain_item::SecItemAdd;

    const SERVICE: &str = "MyKey biometric unlock";
    const ACCOUNT: &str = "master-password";

    pub fn is_available() -> bool {
        true
    }

    pub fn is_configured() -> bool {
        let result = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(ACCOUNT)
            .load_attributes(true)
            .limit(1)
            .search();
        matches!(result, Ok(items) if !items.is_empty())
    }

    pub fn store_master_password(master_password: &str) -> Result<(), String> {
        if master_password.is_empty() {
            return Err("Master password is required".to_string());
        }

        let _ = delete_generic_password(SERVICE, ACCOUNT);
        let mut options = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
        options.set_access_control_options(AccessControlOptions::USER_PRESENCE);
        set_password_with_options(&mut options, master_password.as_bytes())
            .map_err(|e| format!("failed to store biometric unlock item: {e}"))
    }

    pub fn read_master_password() -> Result<String, String> {
        let bytes = get_generic_password(SERVICE, ACCOUNT)
            .map_err(|e| format!("failed to read biometric unlock item: {e}"))?;
        String::from_utf8(bytes)
            .map_err(|_| "stored biometric unlock item is not valid UTF-8".to_string())
    }

    pub fn remove_master_password() -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == errSecItemNotFound => Ok(()),
            Err(err) => Err(format!("failed to remove biometric unlock item: {err}")),
        }
    }

    fn set_password_with_options(options: &mut PasswordOptions, password: &[u8]) -> SecResult<()> {
        use core_foundation_09::base::TCFType;
        use core_foundation_09::data::CFData;
        use core_foundation_09::dictionary::CFDictionary;
        use core_foundation_09::string::CFString;
        use security_framework_sys::item::kSecValueData;

        options.query.push((
            unsafe { CFString::wrap_under_get_rule(kSecValueData) },
            CFData::from_buffer(password).into_CFType(),
        ));

        let params = CFDictionary::from_CFType_pairs(&options.query);
        cvt(unsafe { SecItemAdd(params.as_concrete_TypeRef(), std::ptr::null_mut()) })
    }

    fn cvt(status: i32) -> SecResult<()> {
        if status == errSecSuccess {
            Ok(())
        } else {
            Err(SecError::from_code(status))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn is_available() -> bool {
        false
    }

    pub fn is_configured() -> bool {
        false
    }

    pub fn store_master_password(_master_password: &str) -> Result<(), String> {
        Err("Touch ID keychain unlock is only available on macOS".to_string())
    }

    pub fn read_master_password() -> Result<String, String> {
        Err("Touch ID keychain unlock is only available on macOS".to_string())
    }

    pub fn remove_master_password() -> Result<(), String> {
        Ok(())
    }
}

pub use platform::*;
