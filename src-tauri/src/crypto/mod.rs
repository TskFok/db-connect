//! 连接凭证加密模块
//!
//! 使用 AES-256-GCM 加密敏感数据，密钥存储在系统钥匙串中。

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use keyring::Entry;
use rand_core::RngCore;

const SERVICE_NAME: &str = "db-connect";
const KEY_ID: &str = "config-encryption-key";
const NONCE_SIZE: usize = 12;
const KEY_SIZE: usize = 32;

/// 获取或生成加密密钥
fn get_or_create_key() -> Result<[u8; KEY_SIZE], String> {
    let entry =
        Entry::new(SERVICE_NAME, KEY_ID).map_err(|e| format!("初始化密钥存储失败: {}", e))?;

    if let Ok(encoded) = entry.get_password() {
        let decoded = BASE64
            .decode(&encoded)
            .map_err(|e| format!("解码密钥失败: {}", e))?;
        if decoded.len() == KEY_SIZE {
            let mut key = [0u8; KEY_SIZE];
            key.copy_from_slice(&decoded);
            return Ok(key);
        }
    }

    // 生成新密钥
    let mut key = [0u8; KEY_SIZE];
    rand_core::OsRng.fill_bytes(&mut key);
    let encoded = BASE64.encode(key);
    entry
        .set_password(&encoded)
        .map_err(|e| format!("保存密钥失败: {}", e))?;
    Ok(key)
}

fn encrypt_with_key(plaintext: &[u8], key: &[u8; KEY_SIZE]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("创建加密器失败: {}", e))?;

    let mut nonce = [0u8; NONCE_SIZE];
    rand_core::OsRng.fill_bytes(&mut nonce);
    let nonce = Nonce::from_slice(&nonce);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("加密失败: {}", e))?;

    let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    result.extend_from_slice(nonce);
    result.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(&result))
}

fn decrypt_with_key(encoded: &str, key: &[u8; KEY_SIZE]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("创建解密器失败: {}", e))?;

    let combined = BASE64
        .decode(encoded)
        .map_err(|e| format!("解码密文失败: {}", e))?;

    if combined.len() < NONCE_SIZE {
        return Err("密文格式无效".to_string());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "解密失败: 密文可能已损坏或密钥不匹配".to_string())?;
    Ok(plaintext)
}

/// 加密数据
pub fn encrypt(plaintext: &[u8]) -> Result<String, String> {
    encrypt_with_key(plaintext, &get_or_create_key()?)
}

/// 解密数据
pub fn decrypt(encoded: &str) -> Result<Vec<u8>, String> {
    decrypt_with_key(encoded, &get_or_create_key()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [7u8; KEY_SIZE];
        let plaintext = b"hello world";
        let encrypted = encrypt_with_key(plaintext, &key).unwrap();
        assert_ne!(plaintext.as_slice(), encrypted.as_bytes());
        let decrypted = decrypt_with_key(&encrypted, &key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let key1 = [1u8; KEY_SIZE];
        let key2 = [2u8; KEY_SIZE];
        let encrypted = encrypt_with_key(b"secret", &key1).unwrap();
        assert!(decrypt_with_key(&encrypted, &key2).is_err());
    }

    #[test]
    fn test_decrypt_invalid_ciphertext_fails() {
        let key = [3u8; KEY_SIZE];
        assert!(decrypt_with_key("not-valid-base64!!!", &key).is_err());
    }
}
