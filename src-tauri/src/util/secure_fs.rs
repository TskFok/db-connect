use std::fs::{File, OpenOptions};
use std::path::Path;

/// 打开一个仅当前用户可读写的普通文件，并在返回前清空已有内容。
///
/// 文件创建时即使用 0o600。对于已有文件，先通过已打开的文件句柄收紧权限，
/// 再截断内容，避免权限调整失败时已经破坏原文件。符号链接和非普通文件会被拒绝。
pub fn create_secure_file(path: &Path) -> Result<File, String> {
    let file = open_secure_file_without_truncating(path)?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("获取安全文件元数据失败: {}", e))?;
    if !metadata.file_type().is_file() {
        return Err(format!("安全文件路径不是普通文件: {}", path.display()));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置安全文件权限失败: {}", e))?;
    }

    file.set_len(0)
        .map_err(|e| format!("清空安全文件失败: {}", e))?;
    Ok(file)
}

#[cfg(unix)]
fn open_secure_file_without_truncating(path: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);

    options
        .open(path)
        .map_err(|e| format!("打开安全文件失败 ({}): {}", path.display(), e))
}

#[cfg(windows)]
fn open_secure_file_without_truncating(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    // FILE_FLAG_OPEN_REPARSE_POINT 让句柄指向链接自身，后续普通文件检查会拒绝它。
    OpenOptions::new()
        .write(true)
        .create(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| format!("打开安全文件失败 ({}): {}", path.display(), e))
}

#[cfg(not(any(unix, windows)))]
fn open_secure_file_without_truncating(path: &Path) -> Result<File, String> {
    reject_symbolic_link(path)?;
    OpenOptions::new()
        .write(true)
        .create(true)
        .open(path)
        .map_err(|e| format!("打开安全文件失败 ({}): {}", path.display(), e))
}

#[cfg(not(any(unix, windows)))]
fn reject_symbolic_link(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("安全文件路径不能是符号链接: {}", path.display()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "检查安全文件路径失败 ({}): {}",
            path.display(),
            error
        )),
    }
}

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
    use std::io::Write;

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

    #[test]
    fn create_secure_file_creates_a_private_file() {
        let dir = std::env::temp_dir().join(format!(
            "db-connect-secure-create-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("secret.txt");

        let mut file = create_secure_file(&path).unwrap();
        file.write_all(b"secret").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = file.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        drop(file);
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn create_secure_file_truncates_an_existing_regular_file() {
        let dir = std::env::temp_dir().join(format!(
            "db-connect-secure-existing-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("secret.txt");
        fs::write(&path, b"old secret").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }

        let file = create_secure_file(&path).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 0);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = file.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        drop(file);
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn create_secure_file_stays_private_after_a_partial_write_error() {
        fn write_partially_then_fail(path: &Path) -> Result<(), String> {
            let mut file = create_secure_file(path)?;
            file.write_all(b"partial secret")
                .map_err(|e| format!("写入测试数据失败: {e}"))?;
            Err("模拟后续写入失败".to_string())
        }

        let dir = std::env::temp_dir().join(format!(
            "db-connect-secure-partial-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("secret.txt");

        assert!(write_partially_then_fail(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"partial secret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        fs::remove_file(&path).unwrap();
        fs::remove_dir(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn create_secure_file_rejects_a_symbolic_link_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join(format!(
            "db-connect-secure-symlink-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();
        let target = dir.join("target.txt");
        let link = dir.join("link.txt");
        fs::write(&target, b"keep me").unwrap();
        symlink(&target, &link).unwrap();

        let result = create_secure_file(&link);

        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
        fs::remove_file(&link).unwrap();
        fs::remove_file(&target).unwrap();
        fs::remove_dir(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn create_secure_file_rejects_a_fifo_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!(
            "db-connect-secure-fifo-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("named-pipe");
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

        let worker_path = path.clone();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender.send(create_secure_file(&worker_path)).unwrap();
        });

        let (result, initially_blocked) = match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(result) => (result, false),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 让缺少 O_NONBLOCK 的错误实现解除阻塞，以便测试能安全失败并清理现场。
                let reader = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&path)
                    .unwrap();
                let result = receiver.recv_timeout(Duration::from_millis(500)).unwrap();
                drop(reader);
                (result, true)
            }
            Err(error) => panic!("接收安全文件结果失败: {error}"),
        };
        worker.join().unwrap();

        fs::remove_file(&path).unwrap();
        fs::remove_dir(&dir).unwrap();
        assert!(!initially_blocked, "打开 FIFO 时发生阻塞");
        assert!(result.is_err());
    }

    #[test]
    fn create_secure_file_rejects_a_directory() {
        let dir = std::env::temp_dir().join(format!(
            "db-connect-secure-directory-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();

        let result = create_secure_file(&dir);

        assert!(result.is_err());
        fs::remove_dir(&dir).unwrap();
    }
}
