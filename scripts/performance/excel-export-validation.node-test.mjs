import test from "node:test";
import assert from "node:assert/strict";
import writeXlsxFile from "write-excel-file/universal";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { verifyExcelWorkbook } from "./excel-export-validation.mjs";

const blob = await writeXlsxFile([
  { sheet: "真实_导出", data: [
    ["文本", "日期", "整数", "布尔", "空值"],
    ["中文🙂<&", "2026-09-30T01:02:03.000Z", "9007199254740993", true, ""],
    ["末行🙂", "2000-01-01T00:00:00.000Z", "-9007199254740993", false, ""],
  ] },
  { sheet: "明细", data: [["名称"], ["第二表"]] },
]).toBlob();
const bytes = new Uint8Array(await blob.arrayBuffer());
function mutated(path, mutate) {
  const files = unzipSync(bytes);
  files[path] = strToU8(mutate(strFromU8(files[path])));
  return zipSync(files);
}
test("固定多表夹具按坐标核验全部列、特殊值与末行", () => {
  const result = verifyExcelWorkbook(bytes);
  assert.deepEqual(result.sheets.map((sheet) => sheet.coordinatesChecked), [15, 2]);
});
for (const [name, path, mutate] of [
  ["表名错误", "xl/workbook.xml", (xml) => xml.replace('name="明细"', 'name="错误"')],
  ["列值互换但共享字符串仍完整", "xl/worksheets/sheet1.xml", (xml) => xml.replace('r="B2"', 'r="Z2"').replace('r="C2"', 'r="B2"').replace('r="Z2"', 'r="C2"')],
  ["大整数精度丢失", "xl/sharedStrings.xml", (xml) => xml.replace('9007199254740993', '9007199254740992')],
  ["日期值错误", "xl/sharedStrings.xml", (xml) => xml.replace('2026-09-30T01:02:03.000Z', '2026-09-30')],
  ["NULL意外变成false", "xl/worksheets/sheet1.xml", (xml) => xml.replace('</row><row r="3">', '<c r="E2" t="b"><v>0</v></c></row><row r="3">')],
  ["Unicode丢失", "xl/sharedStrings.xml", (xml) => xml.replace('中文🙂', '中文')],
  ["末行缺失", "xl/worksheets/sheet1.xml", (xml) => xml.replace(/<row r="3">.*?<\/row>/, '')],
  ["XML损坏", "xl/workbook.xml", (xml) => xml.replace('</workbook>', '')],
]) test(`拒绝${name}`, () => assert.throws(() => verifyExcelWorkbook(mutated(path, mutate))));
