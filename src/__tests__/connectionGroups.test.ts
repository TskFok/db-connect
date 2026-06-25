import { describe, expect, it } from "vitest";
import {
  UNGROUPED_GROUP_ID,
  groupConnections,
  groupDropId,
  groupSortId,
  moveConnectionInGroups,
  reorderConnectionGroupsByDrag,
} from "../utils/connectionGroups";

describe("connectionGroups", () => {
  it("按 group_id 分组并保留未分组顺序", () => {
    const result = groupConnections(
      [{ id: "g1", name: "Dev" }],
      [
        { id: "c1", name: "A", host: "h", port: 3306, username: "u" },
        {
          id: "c2",
          name: "B",
          host: "h",
          port: 3306,
          username: "u",
          group_id: "g1",
        },
      ]
    );

    expect(result[0].id).toBe(UNGROUPED_GROUP_ID);
    expect(result[0].connections.map((c) => c.id)).toEqual(["c1"]);
    expect(result[1].connections.map((c) => c.id)).toEqual(["c2"]);
  });

  it("没有未分组连接时不返回未分组伪组", () => {
    const result = groupConnections(
      [{ id: "g1", name: "Dev" }],
      [
        {
          id: "c1",
          name: "A",
          host: "h",
          port: 3306,
          username: "u",
          group_id: "g1",
        },
      ]
    );

    expect(result.map((group) => group.id)).toEqual(["g1"]);
  });

  it("跨组移动连接并返回目标 group_id 与全局顺序", () => {
    const result = moveConnectionInGroups({
      activeConnectionId: "c1",
      overId: "group:g1",
      groups: [
        {
          id: UNGROUPED_GROUP_ID,
          name: "未分组",
          connections: [
            { id: "c1", name: "A", host: "h", port: 3306, username: "u" },
          ],
        },
        { id: "g1", name: "Dev", connections: [] },
      ],
    });

    expect(result).toEqual({
      connectionId: "c1",
      groupId: "g1",
      orderedIds: ["c1"],
    });
  });

  it("同组移动连接时按目标连接位置生成全局顺序", () => {
    const result = moveConnectionInGroups({
      activeConnectionId: "c3",
      overId: "connection:c1",
      groups: [
        {
          id: UNGROUPED_GROUP_ID,
          name: "未分组",
          connections: [
            { id: "c1", name: "A", host: "h", port: 3306, username: "u" },
            { id: "c2", name: "B", host: "h", port: 3306, username: "u" },
            { id: "c3", name: "C", host: "h", port: 3306, username: "u" },
          ],
        },
      ],
    });

    expect(result).toEqual({
      connectionId: "c3",
      groupId: null,
      orderedIds: ["c3", "c1", "c2"],
    });
  });

  it("重排自定义分组时保留未分组固定在最前", () => {
    const result = reorderConnectionGroupsByDrag({
      activeGroupId: "g3",
      overId: groupSortId("g1"),
      groups: [
        {
          id: UNGROUPED_GROUP_ID,
          name: "未分组",
          connections: [],
          system: true,
        },
        { id: "g1", name: "Dev", collapsed: true, connections: [] },
        { id: "g2", name: "Stage", collapsed: true, connections: [] },
        { id: "g3", name: "Prod", collapsed: true, connections: [] },
      ],
    });

    expect(result).toEqual(["g3", "g1", "g2"]);
  });

  it("分组拖到分组标题落点时也能生成新的分组顺序", () => {
    const result = reorderConnectionGroupsByDrag({
      activeGroupId: "g1",
      overId: groupDropId("g3"),
      groups: [
        {
          id: UNGROUPED_GROUP_ID,
          name: "未分组",
          connections: [],
          system: true,
        },
        { id: "g1", name: "Dev", collapsed: true, connections: [] },
        { id: "g2", name: "Stage", collapsed: true, connections: [] },
        { id: "g3", name: "Prod", collapsed: true, connections: [] },
      ],
    });

    expect(result).toEqual(["g2", "g3", "g1"]);
  });

  it("展开的分组不能拖拽排序", () => {
    const result = reorderConnectionGroupsByDrag({
      activeGroupId: "g3",
      overId: groupSortId("g1"),
      groups: [
        {
          id: UNGROUPED_GROUP_ID,
          name: "未分组",
          connections: [],
          system: true,
        },
        { id: "g1", name: "Dev", collapsed: true, connections: [] },
        { id: "g2", name: "Stage", collapsed: true, connections: [] },
        { id: "g3", name: "Prod", collapsed: false, connections: [] },
      ],
    });

    expect(result).toBeNull();
  });

  it("分组拖到展开分组内连接落点时不生成分组顺序", () => {
    const result = reorderConnectionGroupsByDrag({
      activeGroupId: "g3",
      overId: "connection:c1",
      groups: [
        {
          id: UNGROUPED_GROUP_ID,
          name: "未分组",
          connections: [],
          system: true,
        },
        {
          id: "g1",
          name: "Dev",
          collapsed: false,
          connections: [
            {
              id: "c1",
              name: "A",
              host: "h",
              port: 3306,
              username: "u",
            },
          ],
        },
        { id: "g2", name: "Stage", collapsed: true, connections: [] },
        { id: "g3", name: "Prod", collapsed: true, connections: [] },
      ],
    });

    expect(result).toBeNull();
  });
});
