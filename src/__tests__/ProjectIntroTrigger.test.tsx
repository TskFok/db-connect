import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectIntroTrigger } from "../components/common/ProjectIntroTrigger";

describe("ProjectIntroTrigger", () => {
  it("点击时调用 onOpen", () => {
    const onOpen = vi.fn();
    render(<ProjectIntroTrigger onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "功能介绍" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
