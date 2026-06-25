import { useState, useEffect, useRef } from "react";
import { Select, Button, Space, Checkbox } from "antd";
import { SafeInput } from "../common/SafeInput";
import { SearchOutlined, PlusOutlined, MinusCircleOutlined } from "@ant-design/icons";
import {
  buildWhereClauseFromFilters,
  columnSupportsEmptyStringValue,
  WhereOperator,
  WhereFilterConfig,
  WHERE_OPERATORS,
  TWO_VALUE_OPERATORS,
  NO_VALUE_OPERATORS,
  ColumnTypesMap,
} from "../../utils/whereFilterUtils";
import type { DatabaseType } from "../../types";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

interface WhereFilterBuilderProps {
  /** 可选列名 */
  columns: string[];
  /** 可选，列名到 MySQL column_type 的映射；用于字符串列将数字格式化为字符串 */
  columnTypes?: ColumnTypesMap;
  /** 当前数据库类型，用于生成对应方言的 WHERE 标识符与字符串字面量 */
  databaseType?: DatabaseType | string | null;
  /** 初始筛选行（用于切换表/标签页后恢复） */
  initialFilterRows?: WhereFilterConfig[];
  /** 应用筛选回调；第二个参数为当前有效筛选行，便于父组件持久化 */
  onFilter: (whereClause: string, filterRows?: WhereFilterConfig[]) => void;
  /** 清空筛选回调 */
  onClear?: () => void;
  /** 主按钮文案（默认：筛选）。用于在弹窗场景下显示“保存并应用”等。 */
  primaryButtonText?: string;
  /** 清空按钮文案（默认：清空） */
  clearButtonText?: string;
}

interface FilterRow extends WhereFilterConfig {
  id: string;
}

let rowIdCounter = 0;
function createEmptyRow(): FilterRow {
  return {
    id: `filter-${Date.now()}-${++rowIdCounter}`,
    group: "1",
    column: "",
    operator: "=",
    value: "",
    enabled: true,
  };
}

function configsToFilterRows(configs: WhereFilterConfig[]): FilterRow[] {
  return configs.map((c, i) => ({
    ...c,
    enabled: c.enabled !== false,
    group: (c.group ?? "1").trim() || "1",
    id: `filter-${Date.now()}-${i}-${rowIdCounter++}`,
  }));
}

/** 比较两个筛选配置是否内容一致（忽略引用） */
function filterConfigsEqual(
  a: WhereFilterConfig[] | undefined,
  b: WhereFilterConfig[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (ax, i) =>
      ax.column === b[i].column &&
      ax.operator === b[i].operator &&
      ax.value === b[i].value &&
      (ax.value2 ?? "") === (b[i].value2 ?? "") &&
      (ax.enabled !== false) === (b[i].enabled !== false) &&
      (ax.group ?? "1") === (b[i].group ?? "1")
  );
}

export function WhereFilterBuilder({
  columns,
  columnTypes,
  databaseType,
  initialFilterRows,
  onFilter,
  onClear,
  primaryButtonText,
  clearButtonText,
}: WhereFilterBuilderProps) {
  const [rows, setRows] = useState<FilterRow[]>(() =>
    initialFilterRows?.length
      ? configsToFilterRows(initialFilterRows)
      : [createEmptyRow()]
  );
  const prevInitialRef = useRef<WhereFilterConfig[] | undefined>(initialFilterRows);
  const selfTriggeredRef = useRef(false);
  const whereSqlDialect = normalizeDatabaseType(databaseType);

  // 表/标签页切换后 store 会晚一拍更新，initialFilterRows 会从上一张表变为当前表，需同步到内部 state
  // 但如果是自身 handleSearch/handleClear 触发的回流变更，跳过重建以保留焦点
  useEffect(() => {
    if (selfTriggeredRef.current) {
      selfTriggeredRef.current = false;
      prevInitialRef.current = initialFilterRows;
      return;
    }
    if (!filterConfigsEqual(prevInitialRef.current, initialFilterRows)) {
      prevInitialRef.current = initialFilterRows;
      setRows(
        initialFilterRows?.length
          ? configsToFilterRows(initialFilterRows)
          : [createEmptyRow()]
      );
    }
  }, [initialFilterRows]);

  const addRow = () => {
    setRows((prev) => [...prev, createEmptyRow()]);
  };

  const removeRow = (id: string) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length > 0 ? next : [createEmptyRow()];
    });
  };

  const updateRow = (id: string, updates: Partial<FilterRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...updates } : r))
    );
  };

  const handleSearch = () => {
    const allValidRows: WhereFilterConfig[] = [];
    for (const row of rows) {
      if (!row.column || !row.operator) continue;
      const group = (row.group ?? "1").trim() || "1";
      const needsTwo = TWO_VALUE_OPERATORS.includes(row.operator as WhereOperator);
      const needsNone = NO_VALUE_OPERATORS.includes(row.operator as WhereOperator);
      const enabled = row.enabled !== false;
      if (needsNone) {
        allValidRows.push({
          column: row.column,
          operator: row.operator,
          value: "",
          enabled,
          group,
        });
      } else if (needsTwo) {
        if (row.value.trim() && row.value2?.trim()) {
          allValidRows.push({
            column: row.column,
            operator: row.operator,
            value: row.value,
            value2: row.value2,
            enabled,
            group,
          });
        }
      } else {
        const trimmed = row.value.trim();
        const allowEmptyForFilter =
          trimmed === "" &&
          (columnSupportsEmptyStringValue(row.column, columnTypes) ||
            row.operator === "LIKE");
        if (trimmed || allowEmptyForFilter) {
          allValidRows.push({
            column: row.column,
            operator: row.operator,
            value: row.value,
            enabled,
            group,
          });
        }
      }
    }
    const enabledRows = allValidRows.filter((r) => r.enabled !== false);
    const clause = buildWhereClauseFromFilters(
      enabledRows,
      columns,
      columnTypes,
      whereSqlDialect
    );
    selfTriggeredRef.current = true;
    onFilter(clause, allValidRows);
  };

  const handleClear = () => {
    setRows([createEmptyRow()]);
    selfTriggeredRef.current = true;
    onFilter("", []);
    onClear?.();
  };

  const hasAnyFilter =
    rows.some(
      (r) =>
        r.column ||
        r.value ||
        (r.value2 ?? "").trim()
    );

  return (
    <Space direction="vertical" size="small" wrap>
      {rows.map((row) => (
        <FilterRowInput
          key={row.id}
          row={row}
          columns={columns}
          onUpdate={(updates) => updateRow(row.id, updates)}
          onRemove={
            rows.length > 1 ? () => removeRow(row.id) : undefined
          }
          onSearch={handleSearch}
        />
      ))}
      <Space wrap size="small">
        <Button
          type="dashed"
          size="small"
          icon={<PlusOutlined />}
          onClick={addRow}
        >
          添加条件
        </Button>
        <Button
          type="primary"
          size="small"
          icon={<SearchOutlined />}
          onClick={handleSearch}
        >
          {primaryButtonText ?? "筛选"}
        </Button>
        {hasAnyFilter && (
          <Button size="small" onClick={handleClear}>
            {clearButtonText ?? "清空"}
          </Button>
        )}
      </Space>
    </Space>
  );
}

function FilterRowInput({
  row,
  columns,
  onUpdate,
  onRemove,
  onSearch,
}: {
  row: FilterRow;
  columns: string[];
  onUpdate: (updates: Partial<FilterRow>) => void;
  onRemove?: () => void;
  onSearch: () => void;
}) {
  const needsTwoValues = TWO_VALUE_OPERATORS.includes(row.operator as WhereOperator);
  const needsNoValue = NO_VALUE_OPERATORS.includes(row.operator as WhereOperator);
  const enabled = row.enabled !== false;

  return (
    <Space wrap size="small" align="center" style={enabled ? undefined : { opacity: 0.45 }}>
      <Select
        size="small"
        style={{ width: 92 }}
        value={(row.group ?? "1").trim() || "1"}
        onChange={(v) => onUpdate({ group: v })}
        options={Array.from({ length: 6 }, (_, i) => {
          const v = String(i + 1);
          return { label: `组 ${v}`, value: v };
        })}
        title="不同组之间用 OR 连接；同组内用 AND 连接"
      />
      <Checkbox
        checked={enabled}
        onChange={(e) => onUpdate({ enabled: e.target.checked })}
        title={enabled ? "点击禁用此条件" : "点击启用此条件"}
        style={enabled ? undefined : { opacity: 1 }}
      />
      <Select
        placeholder="选择列"
        size="small"
        value={row.column || undefined}
        onChange={(v) => onUpdate({ column: v })}
        style={{ width: 140 }}
        allowClear
        showSearch
        optionFilterProp="label"
        filterOption={(input, option) =>
          (option?.label ?? "")
            .toString()
            .toLowerCase()
            .includes(input.toLowerCase())
        }
        options={columns.map((c) => ({ value: c, label: c }))}
      />
      <Select
        placeholder="操作符"
        size="small"
        value={row.operator}
        onChange={(v) => onUpdate({ operator: v as WhereOperator })}
        style={{ width: 160 }}
        options={WHERE_OPERATORS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
      />
      {!needsNoValue && (
        <>
          <SafeInput
            placeholder={needsTwoValues ? "起始值" : "值"}
            title="字符串类型列可不填，表示匹配空字符串 ''"
            size="small"
            value={row.value}
            onChange={(e) => onUpdate({ value: e.target.value })}
            onPressEnter={(e) => {
              if (e.nativeEvent.isComposing) return;
              onSearch();
            }}
            style={{ width: 100 }}
            allowClear
          />
          {needsTwoValues && (
            <SafeInput
              placeholder="结束值"
              size="small"
              value={row.value2 ?? ""}
              onChange={(e) => onUpdate({ value2: e.target.value })}
              onPressEnter={(e) => {
                if (e.nativeEvent.isComposing) return;
                onSearch();
              }}
              style={{ width: 100 }}
              allowClear
            />
          )}
        </>
      )}
      {onRemove && (
        <Button
          type="text"
          size="small"
          icon={<MinusCircleOutlined />}
          onClick={onRemove}
          title="删除该条件"
        />
      )}
    </Space>
  );
}
