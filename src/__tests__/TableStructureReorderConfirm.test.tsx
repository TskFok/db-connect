import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, act } from "@testing-library/react";
import { Modal } from "antd";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ColumnInfo } from "../types";
import { TableStructure } from "../components/table/TableStructure";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";

let capturedOnDragEnd: ((e: DragEndEvent) => void) | undefined;

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  const { DndContext: ActualDndContext, ...rest } = actual;
  return {
    ...rest,
    DndContext: (props: ComponentProps<typeof ActualDndContext>) => {
      capturedOnDragEnd = props.onDragEnd;
      return <ActualDndContext {...props} />;
    },
  };
});

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  alterDatabaseCharset: vi.fn(),
  createDatabase: vi.fn(),
  dropDatabase: vi.fn(),
  renameDatabase: vi.fn(),
  renameTable: vi.fn(),
  alterTableEngine: vi.fn(),
  alterColumn: vi.fn().mockResolvedValue(undefined),
  addColumn: vi.fn(),
  dropColumn: vi.fn(),
  createTable: vi.fn(),
  dropTable: vi.fn(),
  truncateTable: vi.fn(),
  getPrimaryKeys: vi.fn(),
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

const mockActiveConnection = {
  connId: "conn-1",
  config: {
    id: "conn-1",
    name: "测试连接",
    host: "localhost",
    port: 3306,
    username: "root",
  },
};

function col(name: string): ColumnInfo {
  return {
    name,
    column_type: "int",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  };
}

describe("TableStructure 列拖拽重排", () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    capturedOnDragEnd = undefined;
    vi.mocked(api.alterColumn).mockClear();
    vi.mocked(api.getTableStructure).mockResolvedValue([]);

    useDatabaseStore.getState().reset();
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    useDatabaseStore.setState({
      activeConnId: "conn-1",
      selectedDatabase: "mydb",
      selectedTable: "users",
      tableStructure: [col("id"), col("email"), col("name")],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 0,
        data_length: 0, index_length: null,
        comment: "",
      },
    });

    confirmSpy = vi.spyOn(Modal, "confirm").mockImplementation(() => ({
      destroy: () => {},
      update: () => {},
    }));
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it("拖拽结束后弹出确认框，取消时不调用 alterColumn", async () => {
    render(<TableStructure />);

    expect(capturedOnDragEnd).toBeDefined();
    await act(async () => {
      capturedOnDragEnd!({
        active: { id: "name" },
        over: { id: "id" },
      } as unknown as DragEndEvent);
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const opts = confirmSpy.mock.calls[0]![0]!;
    expect(opts.title).toBe("确认调整列顺序？");
    expect(String(opts.content)).toContain("name");
    expect(String(opts.content)).toContain("移动到第一列");

    expect(api.alterColumn).not.toHaveBeenCalled();
  });

  it("在确认框点击确认后调用 alterColumn", async () => {
    render(<TableStructure />);

    await act(async () => {
      capturedOnDragEnd!({
        active: { id: "name" },
        over: { id: "id" },
      } as unknown as DragEndEvent);
    });

    const opts = confirmSpy.mock.calls[0]![0]!;
    await act(async () => {
      await opts.onOk?.();
    });

    expect(api.alterColumn).toHaveBeenCalledTimes(1);
    expect(api.alterColumn).toHaveBeenCalledWith(
      "conn-1",
      "mydb",
      "users",
      expect.objectContaining({
        old_name: "name",
        new_name: "name",
        column_placement: { kind: "first" },
      })
    );
  });
});
