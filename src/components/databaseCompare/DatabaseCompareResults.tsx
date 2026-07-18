import {
  Alert,
  Checkbox,
  Input,
  Result,
  Segmented,
  Statistic,
  Switch,
  Table,
  Tag,
} from "antd";
import { WarningOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import type { ColumnsType } from "antd/es/table";
import type {
  ColumnDiff,
  DatabaseCompareResult,
  SchemaDiffStatus,
  TableDiff,
} from "../../types";
import {
  filterTableDiffs,
  formatChangedFields,
  formatColumnSideValues,
  formatSchemaDiffStatus,
} from "../../utils/databaseCompare";
import {
  eligibleSyncTableNames,
  normalizeSyncSelection,
  toggleSyncTable,
} from "../../utils/databaseSync";

export interface DatabaseCompareResultsProps {
  result: DatabaseCompareResult;
  disabled: boolean;
  selectedTableNames: string[];
  includeDrops: boolean;
  onSelectionChange: (tableNames: string[]) => void;
  onIncludeDropsChange: (checked: boolean) => void;
}

type StatusFilter = "all" | SchemaDiffStatus;

const STATUS_TAG_COLORS: Record<SchemaDiffStatus, string> = {
  source_only: "gold",
  target_only: "blue",
  changed: "purple",
};

function DiffStatusTag({ status }: { status: SchemaDiffStatus }) {
  return (
    <Tag color={STATUS_TAG_COLORS[status]}>
      {formatSchemaDiffStatus(status)}
    </Tag>
  );
}

export function DatabaseCompareResults({
  result,
  disabled,
  selectedTableNames,
  includeDrops,
  onSelectionChange,
  onIncludeDropsChange,
}: DatabaseCompareResultsProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setStatusFilter("all");
    setSearch("");
  }, [result]);

  const eligibleNames = useMemo(
    () => eligibleSyncTableNames(result.tables, includeDrops),
    [includeDrops, result.tables]
  );
  const eligibleNameSet = useMemo(
    () => new Set(eligibleNames),
    [eligibleNames]
  );
  const eligibleSelectedCount = selectedTableNames.filter((name) =>
    eligibleNameSet.has(name)
  ).length;
  const allSelected =
    eligibleNames.length > 0 && eligibleSelectedCount === eligibleNames.length;
  const partiallySelected =
    eligibleSelectedCount > 0 && eligibleSelectedCount < eligibleNames.length;
  const filteredTables = useMemo(
    () => filterTableDiffs(result.tables, statusFilter, search),
    [result.tables, search, statusFilter]
  );

  const columnColumns = useMemo<ColumnsType<ColumnDiff>>(
    () => [
      { title: "字段名", dataIndex: "name", key: "name", width: 160 },
      {
        title: "差异状态",
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (status: SchemaDiffStatus) => <DiffStatusTag status={status} />,
      },
      {
        title: "变化属性",
        dataIndex: "changed_fields",
        key: "changed_fields",
        width: 180,
        render: (fields: ColumnDiff["changed_fields"]) =>
          formatChangedFields(fields),
      },
      {
        title: "源端值",
        key: "source",
        width: 300,
        render: (_value, column) => formatColumnSideValues(column, "source"),
      },
      {
        title: "目标端值",
        key: "target",
        width: 300,
        render: (_value, column) => formatColumnSideValues(column, "target"),
      },
    ],
    []
  );

  const tableColumns = useMemo<ColumnsType<TableDiff>>(
    () => [
      { title: "表名", dataIndex: "name", key: "name" },
      {
        title: "差异状态",
        dataIndex: "status",
        key: "status",
        width: 140,
        render: (status: SchemaDiffStatus) => <DiffStatusTag status={status} />,
      },
    ],
    []
  );

  return (
    <div className="database-compare-results">
      <div className="database-compare-summary">
        <Statistic title="仅源端表" value={result.summary.source_only_tables} />
        <Statistic
          title="仅目标端表"
          value={result.summary.target_only_tables}
        />
        <Statistic title="结构变化表" value={result.summary.changed_tables} />
        <Statistic title="差异字段" value={result.summary.different_columns} />
      </div>

      {result.tables.length === 0 ? (
        <Result status="success" title="两个数据库结构一致" />
      ) : (
        <>
          <div className="database-compare-toolbar">
            <Input.Search
              aria-label="搜索表名"
              allowClear
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索表名"
            />
            <Segmented<StatusFilter>
              aria-label="差异状态筛选"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { label: "全部", value: "all" },
                { label: "仅源端", value: "source_only" },
                { label: "仅目标端", value: "target_only" },
                { label: "结构变化", value: "changed" },
              ]}
            />
          </div>

          <div className="database-sync-selection-toolbar">
            <div className="database-sync-selection-summary">
              <Checkbox
                aria-label="选择全部可同步表"
                checked={allSelected}
                indeterminate={partiallySelected}
                disabled={disabled || eligibleNames.length === 0}
                onChange={(event) =>
                  onSelectionChange(event.target.checked ? eligibleNames : [])
                }
              >
                选择全部可同步表
              </Checkbox>
              <span
                className="database-sync-selection-count"
                aria-live="polite"
              >
                已选择 {eligibleSelectedCount} / {eligibleNames.length} 张表
              </span>
            </div>
            <div className="database-sync-drop-control">
              <span>允许删除目标端结构</span>
              <Switch
                aria-label="允许删除目标端结构"
                checked={includeDrops}
                disabled={disabled}
                onChange={(checked) => {
                  onIncludeDropsChange(checked);
                  onSelectionChange(
                    normalizeSyncSelection(
                      selectedTableNames,
                      result.tables,
                      checked
                    )
                  );
                }}
              />
            </div>
          </div>

          {includeDrops ? (
            <Alert
              type="warning"
              showIcon
              icon={
                <WarningOutlined
                  data-testid="database-sync-drop-warning-icon"
                  aria-hidden
                />
              }
              message="已包含删除操作"
              description="同步计划可能包含删除表或字段操作，请务必在执行前检查 SQL。"
            />
          ) : (
            <div className="database-sync-drop-hint">
              目标端独有表默认不参与同步
            </div>
          )}

          <div className="database-compare-table-wrap">
            <Table<TableDiff>
              rowKey="name"
              size="small"
              pagination={false}
              columns={tableColumns}
              dataSource={filteredTables}
              scroll={{ x: 520 }}
              rowSelection={{
                columnWidth: 48,
                hideSelectAll: true,
                preserveSelectedRowKeys: true,
                selectedRowKeys: selectedTableNames,
                getCheckboxProps: (table) => ({
                  "aria-label": `选择 ${table.name}`,
                  disabled:
                    disabled ||
                    (!includeDrops && table.status === "target_only"),
                }),
                onSelect: (table, selected) =>
                  onSelectionChange(
                    toggleSyncTable(selectedTableNames, table.name, selected)
                  ),
              }}
              expandable={{
                rowExpandable: (table) => table.status === "changed",
                expandedRowRender: (table) => (
                  <div className="database-compare-expanded-table">
                    <Table<ColumnDiff>
                      rowKey="name"
                      size="small"
                      pagination={false}
                      columns={columnColumns}
                      dataSource={table.columns}
                      scroll={{ x: 1060 }}
                    />
                  </div>
                ),
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
