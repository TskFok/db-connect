use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GitHubIssueApiResponse {
    html_url: String,
}

/// 使用 GitHub REST API 创建 Issue（需具备 `issues: write` 的 token）
#[tauri::command]
pub async fn create_github_issue(
    owner: String,
    repo: String,
    token: String,
    title: String,
    body: String,
) -> Result<String, String> {
    let owner = owner.trim();
    let repo = repo.trim();
    if owner.is_empty() || owner.contains('/') || owner.contains(' ') {
        return Err("owner 无效".to_string());
    }
    if repo.is_empty() || repo.contains('/') || repo.contains(' ') {
        return Err("repo 无效".to_string());
    }

    let token = token.trim();
    if token.is_empty() {
        return Err("缺少 GitHub token".to_string());
    }

    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues");

    let client = reqwest::Client::builder()
        .user_agent(concat!("db-connect/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let res = client
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({
            "title": title,
            "body": body,
        }))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    let status = res.status();
    let body_text = res.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("GitHub API 返回 {status}: {body_text}"));
    }

    let parsed: GitHubIssueApiResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("解析响应失败: {e}"))?;

    Ok(parsed.html_url)
}
