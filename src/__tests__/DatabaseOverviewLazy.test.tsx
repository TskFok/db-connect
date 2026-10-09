import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DatabaseOverview } from "../components/database/DatabaseOverview";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import * as api from "../services/tauriCommands";
const loads = vi.hoisted(() => ({ routines: 0, events: 0 }));
vi.mock("../services/tauriCommands");
vi.mock("../components/database/RoutineList", () => {
  loads.routines++;
  return {
    RoutineList: ({ remeasureKey }: { remeasureKey: string }) => (
      <output aria-label="例程重测">{remeasureKey}</output>
    ),
  };
});
vi.mock("../components/database/EventList", () => {
  loads.events++;
  return {
    EventList: ({ remeasureKey }: { remeasureKey: string }) => (
      <output aria-label="事件重测">{remeasureKey}</output>
    ),
  };
});
it("仅激活例程/事件标签时加载模块，切回保留实例并更新重测键", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.mocked(api.executeSql).mockResolvedValue({
    result_type: "select",
    columns: ["ro", "sro"],
    rows: [[0, 0]],
    affected_rows: null,
    message: "",
    execution_time_ms: 0,
  });
  useConnectionStore.setState({
    activeConnection: {
      connId: "lazy-test",
      config: {
        id: "lazy-test",
        name: "测试",
        host: "localhost",
        port: 3306,
        username: "root",
        database_type: "mysql",
      },
    },
  });
  useDatabaseStore.setState({
    selectedDatabase: "app_db",
    tables: { app_db: [] },
    treeLoading: false,
  });
  render(<DatabaseOverview />);
  await act(async () => {});
  expect(loads).toEqual({ routines: 0, events: 0 });
  fireEvent.click(screen.getByRole("tab", { name: /例程/ }));
  expect(await screen.findByLabelText("例程重测")).toHaveTextContent(
    "routines|app_db"
  );
  expect(loads).toEqual({ routines: 1, events: 0 });
  fireEvent.click(screen.getByRole("tab", { name: /事件/ }));
  expect(await screen.findByLabelText("事件重测")).toHaveTextContent(
    "events|app_db"
  );
  expect(loads).toEqual({ routines: 1, events: 1 });
  fireEvent.click(screen.getByRole("tab", { name: /例程/ }));
  await waitFor(() =>
    expect(screen.getByLabelText("例程重测")).toHaveTextContent(
      "routines|app_db"
    )
  );
  expect(loads.routines).toBe(1);
  vi.unstubAllGlobals();
});
