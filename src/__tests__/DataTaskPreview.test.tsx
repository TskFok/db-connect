import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DataTaskPreviewView } from "../components/dataTasks/DataSyncPreview";
import { dataPreview } from "./dataTaskFixtures";
vi.mock("../services/dataTasks", () => ({
  getDataTaskDiff: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
}));
it("镜像空源必须确认范围、删除数量和清空风险，计数无精度损失", async () => {
  await act(async () => {
    render(
      <DataTaskPreviewView
        preview={dataPreview}
        accepted={[]}
        onAcceptedChange={vi.fn()}
      />
    );
  });
  expect(screen.getAllByText(/9,007,199,254,740,993/)[0]).toBeInTheDocument();
  expect(screen.getByLabelText(/空源将清空/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/确认目标范围/));
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});
