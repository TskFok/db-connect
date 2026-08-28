import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Form, type FormInstance } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SslTlsSection } from "../components/connection/SslTlsSection";
import {
  SshTunnelFields,
  type SshTunnelFormValues,
} from "../components/connection/SshTunnelFields";

describe("connection security sections", () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }
  });

  it("SSL 区块由父级状态控制展开并在启用时恢复默认模式", () => {
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      return (
        <Form initialValues={{ sslMode: "disabled" }}>
          <SslTlsSection
            enabled={enabled}
            databaseBrand="PostgreSQL"
            onEnabledChange={setEnabled}
          />
        </Form>
      );
    }

    render(<Harness />);

    const toggle = screen.getByRole("checkbox", { name: "使用 SSL / TLS" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: "SSL 模式" })).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute("aria-controls", "ssl-configuration");
    expect(
      screen.getByRole("combobox", { name: "SSL 模式" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("加密连接（系统信任库 + 校验主机名）")
    ).toBeInTheDocument();
    expect(
      screen.getByText("SSL / TLS 配置（PostgreSQL）")
    ).toBeInTheDocument();
  });

  it("SSH 字段注册到父级传入的表单实例", () => {
    let sshForm: FormInstance<SshTunnelFormValues> | undefined;
    function Harness() {
      const [form] = Form.useForm<SshTunnelFormValues>();
      sshForm = form;
      return <SshTunnelFields form={form} initialValues={{ sshPort: 22 }} />;
    }

    render(<Harness />);

    expect(screen.getByRole("spinbutton", { name: "SSH 端口" })).toHaveValue(
      "22"
    );
    fireEvent.change(screen.getByRole("textbox", { name: "SSH 服务器" }), {
      target: { value: "jump.example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "SSH 用户名" }), {
      target: { value: "deploy" },
    });
    fireEvent.change(screen.getByLabelText("SSH 密码"), {
      target: { value: "secret" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "SSH 私钥路径" }), {
      target: { value: "/keys/id_ed25519" },
    });

    expect(sshForm?.getFieldsValue()).toEqual({
      sshHost: "jump.example.com",
      sshPort: 22,
      sshUsername: "deploy",
      sshPassword: "secret",
      sshKeyPath: "/keys/id_ed25519",
    });
  });
});
