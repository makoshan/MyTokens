// Operator identity = a local secp256k1 key (kept in the vault). The native app
// proves ownership to the multi-tenant gateway with an EIP-191 personal_sign over
// a challenge; the gateway recovers the signer (viem recoverMessageAddress) and
// issues an operator session. Keccak via sha3; ECDSA via k256.
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use sha3::{Digest, Keccak256};

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Generate a valid secp256k1 private key (32 bytes).
pub fn random_signing_key() -> [u8; 32] {
    use rand::RngCore;
    let mut rng = rand::thread_rng();
    loop {
        let mut bytes = [0u8; 32];
        rng.fill_bytes(&mut bytes);
        // Reject the rare out-of-range value so from_bytes always succeeds later.
        if SigningKey::from_bytes((&bytes).into()).is_ok() {
            return bytes;
        }
    }
}

/// EIP-55-less lowercase 0x address derived from the private key.
pub fn address_from_key(privkey: &[u8; 32]) -> Result<String, String> {
    let sk = SigningKey::from_bytes(privkey.into()).map_err(|e| e.to_string())?;
    let point = sk.verifying_key().to_encoded_point(false); // 0x04 || x || y
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    Ok(format!("0x{}", to_hex(&hash[12..])))
}

fn eip191_digest(message: &str) -> [u8; 32] {
    let msg = message.as_bytes();
    let mut hasher = Keccak256::new();
    hasher.update(format!("\x19Ethereum Signed Message:\n{}", msg.len()).as_bytes());
    hasher.update(msg);
    hasher.finalize().into()
}

/// Sign `message` with EIP-191 personal_sign; returns a 65-byte `0x{r}{s}{v}` hex
/// signature (v = 27 + recovery id), exactly what viem's recoverMessageAddress expects.
pub fn eip191_sign(privkey: &[u8; 32], message: &str) -> Result<String, String> {
    let sk = SigningKey::from_bytes(privkey.into()).map_err(|e| e.to_string())?;
    let digest = eip191_digest(message);
    let (sig, recid): (Signature, RecoveryId) =
        sk.sign_prehash_recoverable(&digest).map_err(|e| e.to_string())?;
    let mut out = sig.to_bytes().to_vec(); // r || s (64)
    out.push(27 + recid.to_byte());
    Ok(format!("0x{}", to_hex(&out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::VerifyingKey;

    fn hex_decode(hex: &str) -> Vec<u8> {
        let hex = hex.trim_start_matches("0x");
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn signature_recovers_to_the_signing_address() {
        let key = random_signing_key();
        let addr = address_from_key(&key).unwrap();
        let challenge =
            format!("MyKey operator auth\naddress: {addr}\nissued: 2026-05-21T00:00:00.000Z");
        let sig = hex_decode(&eip191_sign(&key, &challenge).unwrap());
        assert_eq!(sig.len(), 65);

        let signature = Signature::from_slice(&sig[..64]).unwrap();
        let recid = RecoveryId::from_byte(sig[64] - 27).unwrap();
        let recovered =
            VerifyingKey::recover_from_prehash(&eip191_digest(&challenge), &signature, recid).unwrap();
        let point = recovered.to_encoded_point(false);
        let hash = Keccak256::digest(&point.as_bytes()[1..]);
        assert_eq!(format!("0x{}", to_hex(&hash[12..])), addr);
    }
}
