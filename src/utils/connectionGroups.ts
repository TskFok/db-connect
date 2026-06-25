import type { ConnectionConfig, ConnectionGroup } from "../types";

export const UNGROUPED_GROUP_ID = "__ungrouped";
export const GROUP_DROP_PREFIX = "group:";
export const GROUP_SORT_PREFIX = "group-sort:";
export const CONNECTION_DROP_PREFIX = "connection:";
const GROUP_LAYOUT_TRANSITION =
  "transform 180ms ease, opacity 180ms ease, box-shadow 180ms ease, background-color 180ms ease";
const GROUP_ACTIVE_DRAG_TRANSITION = "opacity 120ms ease, box-shadow 120ms ease";

export interface ConnectionGroupView {
  id: string;
  name: string;
  collapsed?: boolean;
  connections: ConnectionConfig[];
  system?: boolean;
}

export interface MoveConnectionInput {
  activeConnectionId: string;
  overId: string;
  groups: ConnectionGroupView[];
}

export interface MoveConnectionResult {
  connectionId: string;
  groupId: string | null;
  orderedIds: string[];
}

export interface ReorderConnectionGroupsInput {
  activeGroupId: string;
  overId: string;
  groups: ConnectionGroupView[];
}

export function getSortableGroupSectionStyle({
  transform,
  transition,
  isDragging,
}: {
  transform: string | undefined;
  transition: string | undefined;
  isDragging: boolean;
}) {
  return {
    transform,
    transition: isDragging
      ? GROUP_ACTIVE_DRAG_TRANSITION
      : (transition ?? GROUP_LAYOUT_TRANSITION),
    opacity: isDragging ? 0.9 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 2 : 0,
    borderRadius: 6,
    boxShadow: isDragging ? "0 8px 18px rgba(0, 0, 0, 0.16)" : "none",
    background: isDragging ? "var(--hover-bg)" : "transparent",
  };
}

function normalizeGroupId(groupId: string): string | null {
  return groupId === UNGROUPED_GROUP_ID ? null : groupId;
}

function connectionIdOf(connection: ConnectionConfig): string | null {
  return connection.id ?? null;
}

function parseOverId(
  overId: string
):
  | { type: "group"; groupId: string }
  | { type: "connection"; connectionId: string }
  | null {
  if (overId.startsWith(GROUP_DROP_PREFIX)) {
    return { type: "group", groupId: overId.slice(GROUP_DROP_PREFIX.length) };
  }
  if (overId.startsWith(GROUP_SORT_PREFIX)) {
    return { type: "group", groupId: overId.slice(GROUP_SORT_PREFIX.length) };
  }
  if (overId.startsWith(CONNECTION_DROP_PREFIX)) {
    return {
      type: "connection",
      connectionId: overId.slice(CONNECTION_DROP_PREFIX.length),
    };
  }
  return null;
}

export function groupDropId(groupId: string): string {
  return `${GROUP_DROP_PREFIX}${groupId}`;
}

export function groupSortId(groupId: string): string {
  return `${GROUP_SORT_PREFIX}${groupId}`;
}

export function groupIdFromSortId(id: string): string | null {
  return id.startsWith(GROUP_SORT_PREFIX)
    ? id.slice(GROUP_SORT_PREFIX.length)
    : null;
}

function groupIdFromDragTargetId(id: string): string | null {
  if (id.startsWith(GROUP_SORT_PREFIX)) {
    return id.slice(GROUP_SORT_PREFIX.length);
  }
  if (id.startsWith(GROUP_DROP_PREFIX)) {
    return id.slice(GROUP_DROP_PREFIX.length);
  }
  return null;
}

export function canDragConnectionGroup(group: ConnectionGroupView): boolean {
  return (
    group.id !== UNGROUPED_GROUP_ID &&
    group.system !== true &&
    group.collapsed === true
  );
}

export function connectionDropId(connectionId: string): string {
  return `${CONNECTION_DROP_PREFIX}${connectionId}`;
}

export function groupConnections(
  groups: ConnectionGroup[],
  connections: ConnectionConfig[]
): ConnectionGroupView[] {
  const groupIds = new Set(groups.map((group) => group.id));
  const ungroupedView: ConnectionGroupView = {
    id: UNGROUPED_GROUP_ID,
    name: "未分组",
    connections: [],
    system: true,
  };
  const customViews = groups.map((group) => ({
    id: group.id,
    name: group.name,
    collapsed: group.collapsed,
    connections: [] as ConnectionConfig[],
  }));
  const byGroupId = new Map<string, ConnectionGroupView>([
    [UNGROUPED_GROUP_ID, ungroupedView],
    ...customViews.map((view) => [view.id, view] as const),
  ]);

  for (const connection of connections) {
    const targetId =
      connection.group_id && groupIds.has(connection.group_id)
        ? connection.group_id
        : UNGROUPED_GROUP_ID;
    byGroupId.get(targetId)?.connections.push(connection);
  }

  return ungroupedView.connections.length > 0
    ? [ungroupedView, ...customViews]
    : customViews;
}

export function moveConnectionInGroups(
  input: MoveConnectionInput
): MoveConnectionResult | null {
  const parsedOver = parseOverId(input.overId);
  if (!parsedOver) return null;

  let activeConnection: ConnectionConfig | null = null;
  const nextGroups = input.groups.map((group) => {
    const connections = group.connections.filter((connection) => {
      if (connectionIdOf(connection) !== input.activeConnectionId) return true;
      activeConnection = connection;
      return false;
    });
    return { ...group, connections };
  });

  if (!activeConnection) return null;

  let targetGroupId: string | null = null;
  let targetIndex: number | null = null;

  if (parsedOver.type === "group") {
    targetGroupId = parsedOver.groupId;
    const group = nextGroups.find((item) => item.id === targetGroupId);
    if (!group) return null;
    targetIndex = group.connections.length;
  } else {
    for (const group of nextGroups) {
      const index = group.connections.findIndex(
        (connection) => connectionIdOf(connection) === parsedOver.connectionId
      );
      if (index !== -1) {
        targetGroupId = group.id;
        targetIndex = index;
        break;
      }
    }
  }

  if (targetGroupId === null || targetIndex === null) return null;
  const targetGroup = nextGroups.find((group) => group.id === targetGroupId);
  if (!targetGroup) return null;

  targetGroup.connections.splice(targetIndex, 0, activeConnection);

  return {
    connectionId: input.activeConnectionId,
    groupId: normalizeGroupId(targetGroupId),
    orderedIds: nextGroups
      .flatMap((group) => group.connections)
      .map((connection) => connection.id)
      .filter((id): id is string => !!id),
  };
}

export function reorderConnectionGroupsByDrag(
  input: ReorderConnectionGroupsInput
): string[] | null {
  const customGroups = input.groups.filter(
    (group) => group.id !== UNGROUPED_GROUP_ID && group.system !== true
  );
  const oldIndex = customGroups.findIndex(
    (group) => group.id === input.activeGroupId
  );
  const activeGroup = oldIndex === -1 ? null : customGroups[oldIndex];
  if (!activeGroup || !canDragConnectionGroup(activeGroup)) return null;

  const overGroupId = groupIdFromDragTargetId(input.overId);
  if (!overGroupId) return null;

  const newIndex = customGroups.findIndex((group) => group.id === overGroupId);
  if (oldIndex === -1 || newIndex === -1) return null;

  const nextGroups = [...customGroups];
  const [moved] = nextGroups.splice(oldIndex, 1);
  if (!moved) return null;
  nextGroups.splice(newIndex, 0, moved);
  return nextGroups.map((group) => group.id);
}
