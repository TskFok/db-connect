import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Flex,
  Form,
  AutoComplete,
  Select,
  Space,
  Steps,
} from "antd";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDataTaskStore } from "../../stores/dataTaskStore";
import { listCompareDatabases } from "../../services/tauriCommands";
import {
  dataTaskErrorMessage,
  getDataTaskCapabilities,
} from "../../services/dataTasks";
import {
  availableDataTaskModes,
  dataTaskModeLabels,
  defaultDataTaskMappings,
} from "../../utils/dataTaskCapabilities";
import type {
  DataEndpoint,
  DataTaskCapabilities,
  DataTaskKind,
  DataTaskRequest,
  DataTaskMode,
  DataTaskSeed,
  TableMapping,
} from "../../types/dataTasks";

export interface DataTaskWizardProps {
  kind: DataTaskKind;
  seed?: DataTaskSeed;
  initialRequest?: DataTaskRequest;
  onStarted: (taskId: string) => void;
  onInvalidate?: () => void;
  disabled?: boolean;
}
export function DataTaskWizard({
  kind,
  seed,
  initialRequest,
  onStarted,
  onInvalidate,
  disabled = false,
}: DataTaskWizardProps) {
  const saved = useConnectionStore((state) => state.savedConnections);
  const busy = useDataTaskStore((state) => state.busy);
  const [source, setSource] = useState<DataEndpoint>(
    initialRequest?.source ??
      seed?.source ?? { saved_connection_id: "", database: "" }
  );
  const [target, setTarget] = useState<DataEndpoint>(
    initialRequest?.target ?? {
      saved_connection_id: "",
      database: "",
    }
  );
  const [databases, setDatabases] = useState<{
    source: string[];
    target: string[];
  }>({ source: [], target: [] });
  const [mappings, setMappings] = useState<TableMapping[]>(
    initialRequest?.mappings ??
      (seed?.tables ?? []).map((table) => ({
        source_table: table,
        target_table: table,
        columns: [{ source_column: "", target_column: "" }],
      }))
  );
  const [mode, setMode] = useState<DataTaskMode>(
    initialRequest?.mode ?? (kind === "row_sync" ? "merge" : "append")
  );
  const [capabilities, setCapabilities] = useState<DataTaskCapabilities | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const mappingEndpoints = useRef<string | null>(
    initialRequest
      ? JSON.stringify([initialRequest.source, initialRequest.target])
      : null
  );
  const previousConfigs = useRef("");
  const previousEndpointIds = useRef("");
  const endpointIds = JSON.stringify([
    source.saved_connection_id,
    target.saved_connection_id,
  ]);
  const selectedSeedTables = JSON.stringify(seed?.tables ?? []);
  const selectedConfigs = JSON.stringify(
    saved.filter((c) =>
      [source.saved_connection_id, target.saved_connection_id].includes(
        c.id ?? ""
      )
    )
  );
  useEffect(() => {
    if (
      previousEndpointIds.current === endpointIds &&
      previousConfigs.current &&
      previousConfigs.current !== selectedConfigs
    ) {
      setError("保存连接已变更，旧预览已作废，请重新预检");
      onInvalidate?.();
    }
    previousConfigs.current = selectedConfigs;
    previousEndpointIds.current = endpointIds;
  }, [selectedConfigs, endpointIds, onInvalidate]);
  useEffect(() => {
    let current = true;
    if (!source.saved_connection_id) return;
    void listCompareDatabases(source.saved_connection_id)
      .then((values) => {
        if (current) setDatabases((d) => ({ ...d, source: values }));
      })
      .catch((e) => {
        if (current) setError(dataTaskErrorMessage(e));
      });
    return () => {
      current = false;
    };
  }, [source.saved_connection_id]);
  useEffect(() => {
    let current = true;
    if (!target.saved_connection_id) return;
    void listCompareDatabases(target.saved_connection_id)
      .then((values) => {
        if (current) setDatabases((d) => ({ ...d, target: values }));
      })
      .catch((e) => {
        if (current) setError(dataTaskErrorMessage(e));
      });
    return () => {
      current = false;
    };
  }, [target.saved_connection_id]);
  useEffect(() => {
    let current = true;
    setCapabilities(null);
    if (
      source.database &&
      target.database &&
      source.saved_connection_id &&
      target.saved_connection_id
    ) {
      void getDataTaskCapabilities(source, target)
        .then((value) => {
          if (current) {
            setCapabilities(value);
            const endpoints = JSON.stringify([source, target]);
            if (mappingEndpoints.current !== endpoints) {
              const selected = JSON.parse(selectedSeedTables) as string[];
              const defaults = selected.length
                ? defaultDataTaskMappings(value, selected)
                : [];
              setMappings(defaults.length <= 100 ? defaults : []);
              mappingEndpoints.current = endpoints;
            }
          }
        })
        .catch((e) => {
          if (current) setError(dataTaskErrorMessage(e));
        });
    }
    return () => {
      current = false;
    };
  }, [source, target, selectedConfigs, selectedSeedTables]);
  const modes = availableDataTaskModes(capabilities, kind);
  const mappingValid = useMemo(
    () =>
      mappings.length > 0 &&
      mappings.length <= 100 &&
      new Set(mappings.map((m) => m.target_table)).size === mappings.length &&
      mappings.every(
        (m) =>
          m.source_table.trim() &&
          m.target_table.trim() &&
          m.columns.length &&
          new Set(m.columns.map((c) => c.source_column)).size ===
            m.columns.length &&
          new Set(m.columns.map((c) => c.target_column)).size ===
            m.columns.length &&
          m.columns.every(
            (c) => c.source_column.trim() && c.target_column.trim()
          )
      ),
    [mappings]
  );
  const changed = () => {
    setError(null);
    onInvalidate?.();
  };
  const updateMapping = (index: number, value: Partial<TableMapping>) => {
    changed();
    setMappings((items) =>
      items.map((m, i) => (i === index ? { ...m, ...value } : m))
    );
  };
  const start = async () => {
    setError(null);
    try {
      onStarted(
        await useDataTaskStore.getState().startPreview({
          protocol_version: 1,
          kind,
          source,
          target,
          mappings,
          mode,
        })
      );
    } catch (e) {
      setError(dataTaskErrorMessage(e));
    }
  };
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="目标物理表必须已存在；建表和改表请使用数据库结构同步。执行使用预览冻结的源快照。"
      />
      <Steps
        size="small"
        current={step}
        items={[
          { title: "源与目标" },
          { title: "表与字段映射" },
          { title: "模式与预检" },
        ]}
      />
      <Form layout="vertical" disabled={disabled || busy}>
        {step === 0 && (
          <Space align="start" style={{ width: "100%" }}>
            {(["source", "target"] as const).map((side) => {
              const endpoint = side === "source" ? source : target;
              const update = side === "source" ? setSource : setTarget;
              const label = side === "source" ? "源端" : "目标端";
              return (
                <Card
                  key={side}
                  size="small"
                  title={label}
                  style={{ minWidth: 280 }}
                >
                  <Form.Item
                    label={`${label}保存连接`}
                    htmlFor={`data-task-${side}-connection`}
                  >
                    <Select
                      id={`data-task-${side}-connection`}
                      virtual={false}
                      value={endpoint.saved_connection_id || undefined}
                      options={saved
                        .filter((c) => c.id)
                        .map((c) => ({ value: c.id!, label: c.name }))}
                      onChange={(id) => {
                        changed();
                        update({ saved_connection_id: id, database: "" });
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    label={`${label}数据库 / schema`}
                    htmlFor={`data-task-${side}-database`}
                  >
                    <Select
                      id={`data-task-${side}-database`}
                      virtual={false}
                      showSearch
                      value={endpoint.database || undefined}
                      options={databases[side].map((database) => ({
                        value: database,
                        label: database,
                      }))}
                      onChange={(database) => {
                        changed();
                        update({ ...endpoint, database });
                      }}
                    />
                  </Form.Item>
                </Card>
              );
            })}
          </Space>
        )}
        {step === 1 && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Alert
              type="info"
              message="请选择需要同步或传输的源表，选中后自动匹配同名目标表和字段，可继续调整表与字段映射。"
            />
            {!!capabilities?.source_tables.length && (
              <Select
                mode="multiple"
                aria-label="选择源表"
                placeholder="选择源表（最多 100 张）"
                maxCount={100}
                style={{ width: "100%" }}
                value={mappings
                  .map((mapping) => mapping.source_table)
                  .filter(Boolean)}
                options={capabilities.source_tables.map((table) => ({
                  value: table.table,
                  label: table.table,
                }))}
                onChange={(selected: string[]) => {
                  changed();
                  setMappings(
                    selected.map(
                      (name) =>
                        mappings.find(
                          (mapping) => mapping.source_table === name
                        ) ??
                        defaultDataTaskMappings(capabilities, [name])[0] ?? {
                          source_table: name,
                          target_table: name,
                          columns: [],
                        }
                    )
                  );
                }}
              />
            )}
            {mappings.map((mapping, index) => (
              <Card
                key={index}
                size="small"
                title={`表映射 ${index + 1}`}
                extra={
                  <Button
                    size="small"
                    onClick={() => {
                      changed();
                      setMappings((items) =>
                        items.filter((_, i) => i !== index)
                      );
                    }}
                  >
                    移除表
                  </Button>
                }
              >
                <Flex align="center" gap={8}>
                  <AutoComplete
                    style={{ flex: 1, minWidth: 0 }}
                    options={capabilities?.source_tables.map((t) => ({
                      value: t.table,
                    }))}
                    aria-label={`源表 ${index + 1}`}
                    placeholder="源表"
                    value={mapping.source_table}
                    onChange={(value) =>
                      updateMapping(index, { source_table: value })
                    }
                  />
                  <span>→</span>
                  <AutoComplete
                    style={{ flex: 1, minWidth: 0 }}
                    options={capabilities?.target_tables.map((t) => ({
                      value: t.table,
                    }))}
                    aria-label={`目标表 ${index + 1}`}
                    placeholder="已存在的目标表"
                    value={mapping.target_table}
                    onChange={(value) =>
                      updateMapping(index, { target_table: value })
                    }
                  />
                </Flex>
                {mapping.columns.map((column, columnIndex) => (
                  <Flex
                    key={columnIndex}
                    align="center"
                    gap={8}
                    style={{ marginTop: 8 }}
                  >
                    <AutoComplete
                      style={{ flex: 1, minWidth: 0 }}
                      options={(
                        capabilities?.source_tables.find(
                          (t) => t.table === mapping.source_table
                        )?.columns ?? []
                      ).map((value) => ({ value }))}
                      aria-label={`源字段 ${index + 1}-${columnIndex + 1}`}
                      placeholder="源字段"
                      value={column.source_column}
                      onChange={(value) =>
                        updateMapping(index, {
                          columns: mapping.columns.map((c, i) =>
                            i === columnIndex
                              ? { ...c, source_column: value }
                              : c
                          ),
                        })
                      }
                    />
                    <span>→</span>
                    <AutoComplete
                      style={{ flex: 1, minWidth: 0 }}
                      options={(
                        capabilities?.target_tables.find(
                          (t) => t.table === mapping.target_table
                        )?.columns ?? []
                      ).map((value) => ({ value }))}
                      aria-label={`目标字段 ${index + 1}-${columnIndex + 1}`}
                      placeholder="目标字段"
                      value={column.target_column}
                      onChange={(value) =>
                        updateMapping(index, {
                          columns: mapping.columns.map((c, i) =>
                            i === columnIndex
                              ? { ...c, target_column: value }
                              : c
                          ),
                        })
                      }
                    />
                    <Button
                      style={{ flexShrink: 0 }}
                      onClick={() =>
                        updateMapping(index, {
                          columns: mapping.columns.filter(
                            (_, i) => i !== columnIndex
                          ),
                        })
                      }
                    >
                      移除
                    </Button>
                  </Flex>
                ))}
                <Button
                  size="small"
                  style={{ marginTop: 8 }}
                  onClick={() =>
                    updateMapping(index, {
                      columns: [
                        ...mapping.columns,
                        { source_column: "", target_column: "" },
                      ],
                    })
                  }
                >
                  添加字段映射
                </Button>
              </Card>
            ))}
            <Button
              disabled={mappings.length >= 100}
              onClick={() => {
                changed();
                setMappings((items) => [
                  ...items,
                  {
                    source_table: "",
                    target_table: "",
                    columns: [{ source_column: "", target_column: "" }],
                  },
                ]);
              }}
            >
              添加表映射
            </Button>
          </Space>
        )}
        {step === 2 && (
          <Form.Item label="执行模式">
            <Select
              aria-label="执行模式"
              value={mode}
              options={(kind === "row_sync"
                ? (["merge", "mirror"] as const)
                : (["append", "replace"] as const)
              ).map((value) => ({
                value,
                label: dataTaskModeLabels[value],
                disabled: !modes.includes(value),
              }))}
              onChange={(value) => {
                changed();
                setMode(value);
              }}
            />
          </Form.Item>
        )}
        {capabilities?.blockers.map((blocker, i) => (
          <Alert
            key={i}
            type="warning"
            showIcon
            message={`${blocker.table ? `${blocker.table}：` : ""}${blocker.message}`}
          />
        ))}
        {error && <Alert type="error" showIcon message={error} />}
        <Space style={{ marginTop: 12 }}>
          {step > 0 && (
            <Button onClick={() => setStep((s) => s - 1)}>上一步</Button>
          )}
          {step < 2 && (
            <Button
              disabled={
                step === 0
                  ? !(source.database && target.database)
                  : !mappingValid
              }
              onClick={() => setStep((s) => s + 1)}
            >
              下一步
            </Button>
          )}
          <Button
            type="primary"
            loading={busy}
            disabled={
              step !== 2 ||
              !mappingValid ||
              !modes.includes(mode) ||
              !!capabilities?.blockers.length
            }
            onClick={() => void start()}
          >
            预检并读取快照
          </Button>
        </Space>
      </Form>
    </Space>
  );
}
