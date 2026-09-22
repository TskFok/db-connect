import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TemporalInput } from "../components/table/TemporalInput";
import type { TemporalKind } from "../utils/temporalValue";

function Field({ initial, kind }: { initial: string; kind: TemporalKind }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TemporalInput
        kind={kind}
        label="字段值"
        value={value}
        onChange={setValue}
      />
      <output aria-label="保存值">{value}</output>
    </>
  );
}

describe("TemporalInput", () => {
  it("选择时间后保存时分秒，不添加日期或转换时区", async () => {
    render(<Field initial="9:15:30.123456" kind="time" />);
    fireEvent.click(screen.getByRole("textbox", { name: "字段值" }));
    const hour = document.querySelector(
      '.ant-picker-time-panel-column:first-child [data-value="10"]'
    )!;
    expect(hour).toBeInTheDocument();
    fireEvent.click(hour);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(screen.getByLabelText("保存值")).toHaveTextContent(
        "10:15:30.123456"
      )
    );
  });

  it("日期时间选择保留时区与微秒，取消选择不会改写原值", async () => {
    render(
      <Field initial="2026-09-22 12:34:56.123456+08:00" kind="datetime" />
    );
    fireEvent.click(screen.getByRole("textbox", { name: "字段值" }));
    fireEvent.click(await screen.findByTitle("2026-09-25"));
    expect(screen.getByLabelText("保存值")).toHaveTextContent(
      "2026-09-22 12:34:56.123456+08:00"
    );
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(screen.getByLabelText("保存值")).toHaveTextContent(
        "2026-09-25 12:34:56.123456+08:00"
      )
    );
  });

  it("无效日期可原样手动输入，切换选择器本身不清空值", () => {
    render(<Field initial="0000-00-00" kind="date" />);
    expect(screen.getByRole("textbox", { name: "字段值" })).toHaveValue(
      "0000-00-00"
    );
    fireEvent.click(screen.getByRole("button", { name: "使用选择器" }));
    expect(screen.getByLabelText("保存值")).toHaveTextContent("0000-00-00");
    fireEvent.click(screen.getByRole("button", { name: "手动输入" }));
    expect(screen.getByRole("textbox", { name: "字段值" })).toHaveValue(
      "0000-00-00"
    );
  });
});
