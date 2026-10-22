import { describe, expect, it } from "vitest";
import {
  formatDataCount,
  describeDataTaskProgress,
  isNewerDataTaskSequence,
} from "../utils/dataTaskProgress";

describe("数据任务无损进度", () => {
  it("保留超过安全整数的计数", () => {
    expect(formatDataCount("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(
      isNewerDataTaskSequence("9007199254740993", "9007199254740992")
    ).toBe(true);
    expect(isNewerDataTaskSequence("9", "10")).toBe(false);
  });
  it("扫描不伪造百分比，取消和提交不提前宣称完成", () => {
    expect(describeDataTaskProgress("reading")).toContain("读取");
    expect(describeDataTaskProgress("cancelling")).toContain("回滚");
    expect(describeDataTaskProgress("committing")).toContain("确认提交结果");
  });
});

it("读取阶段没有百分比，执行在有准确分母时无损计算进度", async () => {
  const { dataTaskPercent } = await import("../utils/dataTaskProgress");
  const { dataSnapshot } = await import("./dataTaskFixtures");
  expect(dataTaskPercent({ ...dataSnapshot, status: "reading" })).toBeNull();
  expect(
    dataTaskPercent({
      ...dataSnapshot,
      status: "executing",
      written_rows: "4503599627370496",
    })
  ).toBe(49);
});
