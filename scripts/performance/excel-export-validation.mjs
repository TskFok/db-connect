import assert from "node:assert/strict";
import { posix } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { JSDOM } from "jsdom";

const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const relationshipAttribute = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const elements = (node, namespace, name) => [...node.getElementsByTagNameNS(namespace, name)];

/** 校验真实 Worker 的固定夹具；值必须位于指定工作表/坐标，不能靠共享字符串存在判断。 */
export function verifyExcelWorkbook(bytes) {
  const files = unzipSync(bytes);
  const xml = (path) => {
    assert(files[path], `XLSX 缺失 ${path}`);
    const dom = new JSDOM(strFromU8(files[path]), { contentType: "application/xml" });
    const document = dom.window.document;
    dom.window.close();
    return document;
  };
  const sheets = elements(xml("xl/workbook.xml"), spreadsheet, "sheet");
  assert.deepEqual(sheets.map((sheet) => sheet.getAttribute("name")), ["真实_导出", "明细"], "工作表名称或顺序不一致");
  const links = elements(xml("xl/_rels/workbook.xml.rels"), relationships, "Relationship");
  const strings = elements(xml("xl/sharedStrings.xml"), spreadsheet, "si").map((item) => elements(item, spreadsheet, "t").map((text) => text.textContent).join(""));
  const expected = [
    [
      ["文本", "日期", "整数", "布尔", "空值"],
      ["中文🙂<&", "2026-09-30T01:02:03.000Z", "9007199254740993", true, ""],
      ["末行🙂", "2000-01-01T00:00:00.000Z", "-9007199254740993", false, ""],
    ],
    [["名称"], ["第二表"]],
  ];
  const validatedSheets = sheets.map((sheet, sheetIndex) => {
    const id = sheet.getAttributeNS(relationshipAttribute, "id");
    const matching = links.filter((link) => link.getAttribute("Id") === id);
    assert.equal(matching.length, 1, "工作表关系必须唯一");
    const link = matching[0];
    assert.equal(link.getAttribute("TargetMode"), null, "工作表关系不能为外部引用");
    assert.equal(link.getAttribute("Type"), `${relationshipAttribute}/worksheet`, "工作表关系类型错误");
    const path = posix.normalize(posix.join("xl", link.getAttribute("Target")));
    assert(path.startsWith("xl/worksheets/"), "工作表关系路径越界");
    const document = xml(path);
    const rows = elements(document, spreadsheet, "row");
    const matrix = expected[sheetIndex];
    assert.deepEqual(rows.map((row) => row.getAttribute("r")), matrix.map((_, index) => String(index + 1)), `${sheetIndex + 1} 表行号或末行错误`);
    const cells = new Map();
    for (const row of rows) {
      for (const cell of elements(row, spreadsheet, "c")) {
        const coordinate = cell.getAttribute("r");
        assert(coordinate?.endsWith(row.getAttribute("r")), "单元格与所在行不一致");
        assert(!cells.has(coordinate), `重复坐标 ${coordinate}`);
        const values = elements(cell, spreadsheet, "v");
        assert(values.length <= 1, `单元格 ${coordinate} 有多个值`);
        const raw = values[0]?.textContent ?? "";
        const type = cell.getAttribute("t");
        let value;
        if (type === "s") {
          assert(/^\d+$/.test(raw) && Number(raw) < strings.length, `${coordinate} 共享字符串索引无效`);
          value = strings[Number(raw)];
        } else if (type === "b") {
          assert(raw === "0" || raw === "1", `${coordinate} 布尔编码无效`);
          value = raw === "1";
        } else if (type === "inlineStr") value = elements(cell, spreadsheet, "t").map((text) => text.textContent).join("");
        else { assert.equal(raw, "", `${coordinate} 日期/大整数必须使用字符串而非数字`); value = ""; }
        cells.set(coordinate, value);
      }
    }
    let checked = 0;
    for (const [rowIndex, row] of matrix.entries()) {
      for (const [columnIndex, value] of row.entries()) {
        const coordinate = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
        assert.deepEqual(cells.get(coordinate) ?? "", value, `${sheet.getAttribute("name")}!${coordinate} 值或类型错误`);
        cells.delete(coordinate);
        checked++;
      }
    }
    assert.equal(cells.size, 0, "工作表存在意外坐标");
    return { name: sheet.getAttribute("name"), path, rows: matrix.length, columns: matrix[0].length, coordinatesChecked: checked };
  });
  return { method: "ZIP 解压与 namespace XML 解析，关系定位工作表并逐坐标/类型比较", sheets: validatedSheets, sheetNamesAndOrder: true, columnOrder: true, bigIntegersAsStrings: true, datesAsISOString: true, nullAsBlank: true, unicodeAndXmlEscaping: true, finalRows: true };
}
