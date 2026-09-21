import { useEffect, useState } from "react";
import { Alert, Input, Modal, Typography } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { copyTextWithBreadcrumb } from "../../utils/crashBreadcrumbs";

const { Link, Text } = Typography;

function isLikelyTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // Tauri 2 注入；测试环境可为 undefined
    "__TAURI_INTERNALS__" in window
  );
}

async function invokeCreateGithubIssue(
  owner: string,
  repo: string,
  token: string,
  title: string,
  body: string
): Promise<string> {
  return invoke<string>("create_github_issue", {
    owner,
    repo,
    token,
    title,
    body,
  });
}

function openGithubNewIssuePage(
  owner: string,
  repo: string,
  title: string,
  body: string
): void {
  const base = `https://github.com/${owner}/${repo}/issues/new`;
  const params = new URLSearchParams({ title });
  const combined = title.length + body.length;
  if (body.length < 6000 && combined < 7500) {
    params.set("body", body);
  }
  window.open(`${base}?${params}`, "_blank", "noopener,noreferrer");
}

export interface CrashIssueUploadModalProps {
  open: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  issueTitle: string;
  issueBody: string;
  onSubmitted?: (issueUrl: string) => void;
}

/**
 * 将崩溃报告提交到 GitHub Issue（桌面端走 API，否则打开浏览器预填页面）
 */
export function CrashIssueUploadModal({
  open,
  onClose,
  owner,
  repo,
  issueTitle,
  issueBody,
  onSubmitted,
}: CrashIssueUploadModalProps) {
  const [token, setToken] = useState("");
  const [title, setTitle] = useState(issueTitle);
  const [body, setBody] = useState(issueBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tauri = isLikelyTauri();

  useEffect(() => {
    setToken("");
    setTitle(issueTitle);
    setBody(issueBody);
    setError(null);
  }, [open, issueTitle, issueBody]);

  const handleOk = async () => {
    if (busy) return;
    setError(null);
    if (tauri) {
      const t = token.trim();
      if (!t) {
        setError("请输入具备 repo issues 权限的 GitHub 个人访问令牌。");
        return;
      }
      setBusy(true);
      try {
        const url = await invokeCreateGithubIssue(owner, repo, t, title, body);
        onSubmitted?.(url);
        setToken("");
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      await copyTextWithBreadcrumb(body, "crash-report-open-issue", {
        owner,
        repo,
      });
      openGithubNewIssuePage(owner, repo, title, body);
      onClose();
    } catch {
      openGithubNewIssuePage(owner, repo, title, body);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="上传崩溃报告到 GitHub"
      open={open}
      onCancel={() => {
        if (busy) return;
        setError(null);
        setToken("");
        onClose();
      }}
      onOk={handleOk}
      okText={tauri ? "提交 Issue" : "复制正文并打开 Issue 页面"}
      cancelText="取消"
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      centered
      width={520}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="请检查下方实际将发送的标题和正文。"
        description={
          <span>
            仓库：
            <Text code>
              {owner}/{repo}
            </Text>
            。确认其中不含密码、连接串或其他不希望公开的信息后再提交。
          </span>
        }
      />
      <label htmlFor="crash-issue-title">
        <Text strong>Issue 标题</Text>
      </label>
      <Input
        id="crash-issue-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
        style={{ marginTop: 6, marginBottom: 12 }}
      />
      <label htmlFor="crash-issue-body">
        <Text strong>Issue 正文</Text>
      </label>
      <Input.TextArea
        id="crash-issue-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={busy}
        autoSize={{ minRows: 8, maxRows: 14 }}
        style={{ marginTop: 6, marginBottom: 12, fontFamily: "monospace" }}
      />
      {tauri ? (
        <>
          <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
            需使用具备该仓库 <Text strong>issues: write</Text> 权限的
            <Link
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noreferrer"
            >
              个人访问令牌
            </Link>
            。令牌仅用于本次请求，不会写入应用设置文件。
          </Text>
          <Input.Password
            placeholder="请输入 GitHub 个人访问令牌"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
          />
        </>
      ) : (
        <Text type="secondary">
          当前为浏览器预览模式：将复制完整报告到剪贴板，并打开 GitHub 新建 Issue
          页面（若 URL 过长则仅预填标题，请粘贴正文）。
        </Text>
      )}
      {error && (
        <Alert
          type="error"
          message={error}
          style={{ marginTop: 12 }}
          showIcon
        />
      )}
    </Modal>
  );
}
