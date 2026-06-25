import { describe, it, expect } from "vitest";
import {
  compareDottedVersion,
  supportsExplainAnalyze,
} from "../utils/mysqlVersion";

describe("mysqlVersion", () => {
  it("compareDottedVersion", () => {
    expect(compareDottedVersion("8.0.18", "8.0.17")).toBeGreaterThan(0);
    expect(compareDottedVersion("8.0.17", "8.0.18")).toBeLessThan(0);
    expect(compareDottedVersion("10.7", "10.6.99")).toBeGreaterThan(0);
  });

  it("supportsExplainAnalyze MySQL 8.0.18+", () => {
    expect(supportsExplainAnalyze("8.0.18-standard")).toBe(true);
    expect(supportsExplainAnalyze("8.0.17")).toBe(false);
    expect(supportsExplainAnalyze("5.7.44-log")).toBe(false);
  });

  it("supportsExplainAnalyze MariaDB 10.7+", () => {
    expect(supportsExplainAnalyze("10.6.16-MariaDB-log")).toBe(false);
    expect(supportsExplainAnalyze("10.7.3-MariaDB")).toBe(true);
  });
});
