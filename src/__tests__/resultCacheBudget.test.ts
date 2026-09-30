import { describe, expect, it } from "vitest";
import {
  createResultCacheController,
  estimateResultBytes,
} from "../utils/resultCacheBudget";

describe("结果缓存预算", () => {
  it("同一身份移交只计费一次并使用新的回收回调", () => {
    const cache = createResultCacheController(10);
    const released: string[] = [];
    cache.track({
      key: "a",
      estimatedBytes: 6,
      evict: () => released.push("old"),
    });
    cache.track({
      key: "a",
      estimatedBytes: 6,
      evict: () => released.push("new"),
    });
    expect(cache.enforce()).toEqual({ retainedBytes: 6, overBudget: false });
    cache.track({
      key: "b",
      estimatedBytes: 6,
      evict: () => released.push("b"),
    });
    expect(released).toEqual(["new"]);
  });
  it("移交已有身份只替换拥有方，不重复估算或计费", () => {
    const cache = createResultCacheController(6);
    let owner = "";
    cache.track({
      key: "a",
      estimatedBytes: 6,
      evict: () => {
        owner = "old";
      },
    });
    expect(
      cache.transfer("a", () => {
        owner = "new";
      })
    ).toBe(true);
    expect(cache.transfer("missing", () => {})).toBe(false);
    cache.track({ key: "b", estimatedBytes: 6, evict: () => {} });
    expect(owner).toBe("new");
  });
  it("优先释放最久未使用的未保护结果", () => {
    const cache = createResultCacheController(12);
    const released: string[] = [];
    for (const key of ["a", "b"])
      cache.track({ key, estimatedBytes: 6, evict: () => released.push(key) });
    cache.touch("a");
    cache.track({
      key: "c",
      estimatedBytes: 6,
      evict: () => released.push("c"),
    });
    expect(released).toEqual(["b"]);
  });
  it("全部保护时允许超预算，所有租约释放后立即回收且重复释放幂等", () => {
    const cache = createResultCacheController(5);
    const released: string[] = [];
    const a = cache.pin("a");
    const b = cache.pin("a");
    cache.track({
      key: "a",
      estimatedBytes: 6,
      evict: () => released.push("a"),
    });
    expect(cache.enforce()).toEqual({ retainedBytes: 6, overBudget: true });
    a();
    a();
    expect(released).toEqual([]);
    b();
    expect(released).toEqual(["a"]);
    expect(cache.enforce()).toEqual({ retainedBytes: 0, overBudget: false });
  });
  it("移除不会回收，新登记不继承已移除记录的租约", () => {
    const cache = createResultCacheController(5);
    const release = cache.pin("a");
    let evictions = 0;
    cache.track({ key: "a", estimatedBytes: 6, evict: () => evictions++ });
    cache.remove("a");
    cache.track({ key: "a", estimatedBytes: 6, evict: () => evictions++ });
    release();
    expect(evictions).toBe(1);
  });
  it("遍历 JSON 值估算 UTF-8 字节，包括 Unicode、转义和预览对象", () => {
    expect(estimateResultBytes(["id"], [[1]])).toBe(11);
    expect(estimateResultBytes(["名"], [["😀"]])).toBe(17);
    expect(
      estimateResultBytes([], [[{ preview: "中", truncated: true }]])
    ).toBe(40);
  });
});
