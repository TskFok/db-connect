import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Form, type FormInstance } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SshTunnelFields,
  type SshTunnelFormValues,
} from "../components/connection/SshTunnelFields";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

function renderSshFields(
  initialValues: Partial<SshTunnelFormValues> = {
    sshHost: "jump.example.com",
    sshPort: 2202,
  }
) {
  let sshForm: FormInstance<SshTunnelFormValues>;
  function Harness() {
    const [form] = Form.useForm<SshTunnelFormValues>();
    sshForm = form;
    return <SshTunnelFields form={form} initialValues={initialValues} />;
  }
  render(<Harness />);
  return () => sshForm;
}

function openConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: "清除主机密钥缓存" }));
  return screen.getByRole("dialog");
}

describe("SSH 主机密钥缓存清理", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
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

  it("确认前展示服务器与清理范围，取消时不修改缓存", async () => {
    renderSshFields();

    const dialog = openConfirmation();

    await waitFor(() => {
      expect(within(dialog).getByText(/jump\.example\.com:2202/)).toBeVisible();
    });
    expect(within(dialog).getByText(/确认服务器身份/)).toBeVisible();
    expect(within(dialog).getByText(/下次连接.*重新记录/)).toBeVisible();
    expect(within(dialog).getByText(/仅清除.*应用/)).toBeVisible();
    expect(
      within(dialog).getByText(/不.*私钥.*系统.*known_hosts/)
    ).toBeVisible();
    expect(mockInvoke).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /取消/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("确认使用打开弹窗时的主机端口快照并显示已清理结果", async () => {
    mockInvoke.mockResolvedValue(true);
    const getForm = renderSshFields({
      sshHost: " jump.example.com ",
      sshPort: 2202,
    });
    const dialog = openConfirmation();

    act(() => {
      getForm().setFieldsValue({ sshHost: "other.example.com", sshPort: 22 });
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清除" }));

    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("clear_ssh_known_host", {
      host: "jump.example.com",
      port: 2202,
    });
    const feedback = await screen.findByRole("alert");
    expect(feedback).toHaveTextContent(/已清除.*jump\.example\.com:2202/);
  });

  it("无缓存记录时显示无需清理的结果", async () => {
    mockInvoke.mockResolvedValue(false);
    renderSshFields();

    fireEvent.click(
      within(openConfirmation()).getByRole("button", { name: "确认清除" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /jump\.example\.com:2202.*无.*缓存/
    );
  });

  it("清理失败时展示后端错误并允许重新操作", async () => {
    mockInvoke.mockRejectedValue("无法写入主机密钥缓存：权限不足");
    renderSshFields();

    fireEvent.click(
      within(openConfirmation()).getByRole("button", { name: "确认清除" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法写入主机密钥缓存：权限不足"
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "清除主机密钥缓存" })
    ).toBeEnabled();
  });

  it("请求处理中阻止重复清理与取消，完成后恢复操作", async () => {
    let finish!: (result: boolean) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    renderSshFields();
    const clear = screen.getByRole("button", { name: "清除主机密钥缓存" });
    const dialog = openConfirmation();
    const confirm = within(dialog).getByRole("button", { name: "确认清除" });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(clear);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /取消/ })).toBeDisabled();
    expect(clear).toBeDisabled();

    await act(async () => finish(true));

    expect(await screen.findByRole("alert")).toHaveTextContent(/已清除/);
    expect(clear).toBeEnabled();
  });

  it.each([
    { sshHost: "", sshPort: 22 },
    { sshHost: "   ", sshPort: 22 },
    { sshHost: "jump example.com", sshPort: 22 },
    { sshHost: "-jump.example.com", sshPort: 22 },
    { sshHost: "*.example.com", sshPort: 22 },
    { sshHost: "jump.example.com", sshPort: undefined },
    { sshHost: "jump.example.com", sshPort: 0 },
    { sshHost: "jump.example.com", sshPort: 65536 },
    { sshHost: "jump.example.com", sshPort: 22.5 },
  ])("无效目标 $sshHost:$sshPort 禁止清理", (values) => {
    renderSshFields(values);

    const clear = screen.getByRole("button", { name: "清除主机密钥缓存" });
    expect(clear).toBeDisabled();
    fireEvent.click(clear);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("编辑为有效 IPv6 主机和端口后可清理，并明确展示端口", async () => {
    mockInvoke.mockResolvedValue(true);
    renderSshFields({ sshPort: 22 });
    expect(
      screen.getByRole("button", { name: "清除主机密钥缓存" })
    ).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "SSH 服务器" }), {
      target: { value: "2001:db8::1" },
    });
    const dialog = openConfirmation();
    await waitFor(() => {
      expect(within(dialog).getByText(/\[2001:db8::1\]:22/)).toBeVisible();
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清除" }));

    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("clear_ssh_known_host", {
      host: "2001:db8::1",
      port: 22,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/已清除/);
  });
});
