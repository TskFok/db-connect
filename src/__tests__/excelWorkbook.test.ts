import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildWorkbookBuffer,
  cellValueForXlsx,
  sanitizeExcelSheetName,
} from "../utils/excelWorkbook";

function xmlFiles(buffer: ArrayBuffer) {
  return Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(buffer))).map(([name, bytes]) => [
      name,
      strFromU8(bytes),
    ])
  );
}

describe("Excel 工作簿内容", () => {
  it("保留已有工作表名清洗和精度转换规则", () => {
    expect(sanitizeExcelSheetName("a:b*c/\\?[]")).toBe("a_b_c_____");
    expect(sanitizeExcelSheetName("")).toBe("Sheet1");
    expect(sanitizeExcelSheetName("x".repeat(40))).toHaveLength(31);
    expect(cellValueForXlsx(null)).toBe("");
    expect(cellValueForXlsx(undefined)).toBe("");
    expect(cellValueForXlsx(42n)).toBe("42");
    expect(cellValueForXlsx(Infinity)).toBe("Infinity");
    expect(cellValueForXlsx(NaN)).toBe("NaN");
  });

  it("解压检查多工作表、列顺序、空值、布尔、整数精度、日期和 Unicode", async () => {
    const longText = "长文本🌏".repeat(3000);
    const files = xmlFiles(
      await buildWorkbookBuffer([
        {
          sheet: "查询:结果",
          data: [
            ["数字", "空值", "布尔", "大整数", "日期", "文本"],
            [
              3.14,
              null,
              true,
              9007199254740993n,
              new Date("2026-09-30T01:02:03.000Z"),
              "中文<&>\t🙂",
            ],
            [
              0,
              undefined,
              false,
              "9223372036854775807",
              "=SUM(A1:A2)",
              longText,
            ],
          ],
        },
        { sheet: "明细", data: [["名称"], ["第二表"]] },
      ])
    );
    const workbook = files["xl/workbook.xml"];
    expect(workbook).toContain('name="查询_结果"');
    expect(workbook).toContain('name="明细"');
    expect(
      Object.keys(files).filter((name) =>
        /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
      )
    ).toHaveLength(2);
    const strings = new DOMParser().parseFromString(
      files["xl/sharedStrings.xml"],
      "text/xml"
    );
    const shared = [...strings.querySelectorAll("si")].map(
      (node) => node.textContent
    );
    const doc = new DOMParser().parseFromString(
      files["xl/worksheets/sheet1.xml"],
      "text/xml"
    );
    const cell = (ref: string) => doc.querySelector(`c[r="${ref}"]`);
    const value = (ref: string) => {
      const node = cell(ref);
      const v = node?.querySelector("v")?.textContent ?? "";
      return node?.getAttribute("t") === "s" ? shared[Number(v)] : v;
    };
    expect(["A1", "B1", "C1", "D1", "E1", "F1"].map(value)).toEqual([
      "数字",
      "空值",
      "布尔",
      "大整数",
      "日期",
      "文本",
    ]);
    expect(value("A2")).toBe("3.14");
    expect(value("B2")).toBe("");
    expect(value("B3")).toBe("");
    expect(cell("C2")?.getAttribute("t")).toBe("b");
    expect(value("C2")).toBe("1");
    expect(value("C3")).toBe("0");
    expect(cell("D2")?.getAttribute("t")).toBe("s");
    expect(value("D2")).toBe("9007199254740993");
    expect(value("D3")).toBe("9223372036854775807");
    expect(value("E2")).toBe("2026-09-30T01:02:03.000Z");
    expect(value("E3")).toBe("=SUM(A1:A2)");
    expect(doc.querySelector("f")).toBeNull();
    expect(value("F2")).toBe("中文<&>\t🙂");
    expect(value("F3")).toBe(longText);
  });

  it("100000 行包含末行，超过上限拒绝且不静默截断", async () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => [index]);
    const files = xmlFiles(
      await buildWorkbookBuffer([{ sheet: "rows", data: [["id"], ...rows] }])
    );
    expect(files["xl/worksheets/sheet1.xml"]).toContain('r="A100001"');
    expect(files["xl/worksheets/sheet1.xml"]).toContain("<v>99999</v>");
    await expect(
      buildWorkbookBuffer([
        { sheet: "rows", data: [["id"], ...rows, [100000]] },
      ])
    ).rejects.toThrow("导出上限");
  });
});
