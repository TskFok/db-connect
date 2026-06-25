import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { MermaidBlock } from "../components/common/MermaidBlock";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: "<svg data-testid='mchart'><text>ok</text></svg>",
    }),
  },
}));

describe("MermaidBlock", () => {
  beforeEach(() => {
    vi.mocked(mermaid.initialize).mockClear();
    vi.mocked(mermaid.render).mockClear();
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: "<svg data-testid='mchart'><text>ok</text></svg>",
    });
  });

  it("调用 mermaid.render 并写入 SVG", async () => {
    const { container } = render(
      <MermaidBlock chart={'flowchart LR\n  A-->B'} minHeight={80} />
    );
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalled();
    });
    const host = container.querySelector(".mermaid-block__svg-host");
    expect(host?.innerHTML).toContain("mchart");
    expect(mermaid.initialize).toHaveBeenCalled();
  });
});
