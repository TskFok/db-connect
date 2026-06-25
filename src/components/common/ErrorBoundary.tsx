import React from "react";
import { Button, Collapse, Modal, message, Space, Typography } from "antd";
import {
  BugOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { getAppVersion } from "../../appVersion";
import { getCrashBreadcrumbs } from "../../utils/crashBreadcrumbs";
import { copyTextWithBreadcrumb } from "../../utils/crashBreadcrumbs";
import {
  buildCrashIssueTitle,
  buildCrashReportBody,
  getConfiguredGithubRepoFull,
  parseGithubOwnerRepo,
} from "../../utils/crashReport";
import { CrashIssueUploadModal } from "./CrashIssueUploadModal";

const { Paragraph, Text } = Typography;

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  uploadOpen: boolean;
}

/**
 * React 错误边界组件
 * 捕获子组件树中的 JS 错误，显示回退 UI 而非白屏
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      uploadOpen: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] 捕获渲染错误:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      uploadOpen: false,
    });
  };

  private getReportParts() {
    const err = this.state.error;
    if (!err) return null;
    const appVersion = getAppVersion();
    const breadcrumbs = getCrashBreadcrumbs();
    const title = buildCrashIssueTitle(
      err.name || "Error",
      err.message || String(err),
      appVersion
    );
    const body = buildCrashReportBody({
      appVersion,
      errorName: err.name || "Error",
      errorMessage: err.message || String(err),
      stack: err.stack ?? null,
      componentStack: this.state.errorInfo?.componentStack ?? null,
      breadcrumbs: breadcrumbs ?? undefined,
    });
    return { title, body };
  }

  handleCopyReport = async () => {
    const parts = this.getReportParts();
    if (!parts) return;
    const text = `标题建议：\n${parts.title}\n\n---\n\n${parts.body}`;
    try {
      await copyTextWithBreadcrumb(text, "error-boundary-copy-report", {});
      message.success("崩溃详情已复制到剪贴板");
    } catch {
      message.error("复制失败，请手动选择下方文本复制");
    }
  };

  handleOpenUpload = () => {
    const repo = getConfiguredGithubRepoFull();
    if (!parseGithubOwnerRepo(repo)) {
      Modal.warning({
        title: "未配置 GitHub 仓库",
        content: `当前仓库字符串无效：${repo}。请在构建环境中设置 VITE_GITHUB_ISSUE_REPO（格式 owner/repo）。`,
      });
      return;
    }
    this.setState({ uploadOpen: true });
  };

  render() {
    if (this.state.hasError) {
      const err = this.state.error;
      const parts = this.getReportParts();
      const repoFull = getConfiguredGithubRepoFull();
      const parsed = parseGithubOwnerRepo(repoFull);

      return (
        <div className="error-boundary-container">
          <BugOutlined
            style={{ fontSize: 48, color: "#ff4d4f", marginBottom: 16 }}
          />
          <h2 style={{ color: "var(--text-primary)" }}>应用遇到了错误</h2>
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            发生了意外渲染错误。您可复制详细日志，或选择将匿名诊断信息上传到 GitHub
            Issue（需确认并自行提供令牌）。
          </Paragraph>
          <Space wrap style={{ marginBottom: 20 }}>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={this.handleRetry}
            >
              重试
            </Button>
            <Button onClick={this.handleReload}>刷新页面</Button>
            <Button icon={<CopyOutlined />} onClick={this.handleCopyReport}>
              复制崩溃详情
            </Button>
            <Button
              type="primary"
              ghost
              icon={<CloudUploadOutlined />}
              onClick={this.handleOpenUpload}
            >
              上传到 GitHub…
            </Button>
          </Space>
          {err && (
            <Collapse
              defaultActiveKey={["msg", "stack"]}
              items={[
                {
                  key: "msg",
                  label: "错误消息",
                  children: (
                    <Text code copyable>
                      {err.message || String(err)}
                    </Text>
                  ),
                },
                ...(err.stack
                  ? [
                      {
                        key: "stack",
                        label: "堆栈",
                        children: (
                          <pre
                            style={{
                              maxHeight: 240,
                              overflow: "auto",
                              fontSize: 12,
                              margin: 0,
                            }}
                          >
                            {err.stack}
                          </pre>
                        ),
                      },
                    ]
                  : []),
                ...(this.state.errorInfo?.componentStack
                  ? [
                      {
                        key: "react",
                        label: "React 组件栈",
                        children: (
                          <pre
                            style={{
                              maxHeight: 200,
                              overflow: "auto",
                              fontSize: 12,
                              margin: 0,
                            }}
                          >
                            {this.state.errorInfo.componentStack}
                          </pre>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {parts && parsed && (
            <CrashIssueUploadModal
              open={this.state.uploadOpen}
              onClose={() => this.setState({ uploadOpen: false })}
              owner={parsed.owner}
              repo={parsed.repo}
              issueTitle={parts.title}
              issueBody={parts.body}
              onSubmitted={(url) => {
                message.success(
                  <span>
                    已创建 Issue：
                    <a href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </span>,
                  6
                );
              }}
            />
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
