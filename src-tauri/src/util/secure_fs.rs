use std::path::Path;

/// 为敏感目录设置较严格的权限。
///
/// 在 Unix 平台上，将权限设置为 0o700（仅当前用户可读写执行）。
/// 在非 Unix 平台上，不做额外处理，保持默认权限。
pub fn set_secure_dir_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let metadata = fs::metadata(path).map_err(|e| format!("获取目录元数据失败: {}", e))?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o700);
        fs::set_permissions(path, perms).map_err(|e| format!("设置目录权限失败: {}", e))?;
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }

    Ok(())
}

/// 为敏感文件设置较严格的权限。
///
/// 在 Unix 平台上，将权限设置为 0o600（仅当前用户可读写）。
/// 在非 Unix 平台上，不做额外处理，保持默认权限。
pub fn set_secure_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let metadata = fs::metadata(path).map_err(|e| format!("获取文件元数据失败: {}", e))?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(path, perms).map_err(|e| format!("设置文件权限失败: {}", e))?;
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_set_secure_dir_permissions() {
        let dir = std::env::temp_dir().join("db-connect-secure-dir-test");
        fs::create_dir_all(&dir).unwrap();

        let result = set_secure_dir_permissions(&dir);
        assert!(result.is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let metadata = fs::metadata(&dir).unwrap();
            let mode = metadata.permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }

        fs::remove_dir(&dir).ok();
    }

    #[test]
    fn test_set_secure_file_permissions() {
        let dir = std::env::temp_dir().join("db-connect-secure-file-test");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.txt");
        fs::write(&file, "secret").unwrap();

        let result = set_secure_file_permissions(&file);
        assert!(result.is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let metadata = fs::metadata(&file).unwrap();
            let mode = metadata.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        fs::remove_file(&file).ok();
        fs::remove_dir(&dir).ok();
    }
}
