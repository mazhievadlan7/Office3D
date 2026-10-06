/**
 * The shared board — the общая доска задач the whole swarm can see (TZ §3.2
 * «единый организм»). Ported in logic from platform/orchestrator/board.js, minus
 * the disk persistence (the browser-side demo holds it in memory; the real
 * Execution Plane persists through its own board). The board is deliberately
 * dumb: it stores and queries. The state machine lives in workItem.ts, the policy
 * in routing.ts, and the controller wires them with the scope gate and audit.
 */

import type { OpsRole } from "./roles";
import type { OpsStatus, OpsWorkItem } from "./types";

const copy = (item: OpsWorkItem): OpsWorkItem => JSON.parse(JSON.stringify(item)) as OpsWorkItem;

export type OpsBoardFilter = {
  role?: OpsRole;
  status?: OpsStatus;
  engagementId?: string;
  open?: boolean;
  limit?: number;
};

export type OpsBoard = {
  get(id: string): OpsWorkItem | null;
  has(id: string): boolean;
  put(item: OpsWorkItem): void;
  remove(id: string): void;
  list(filter?: OpsBoardFilter): OpsWorkItem[];
  summary(): { total: number; byStatus: Record<string, number> };
  clear(): void;
};

/** "involves this role": current holder, origin, target, review or open helper. */
const matchRole = (item: OpsWorkItem, role: OpsRole): boolean =>
  item.currentRole === role || item.originRole === role || item.targetRole === role || item.reviewRole === role || item.help?.helper === role;

export const createBoard = (): OpsBoard => {
  const items = new Map<string, OpsWorkItem>();

  return {
    get: (id) => (items.has(id) ? copy(items.get(id)!) : null),
    has: (id) => items.has(id),

    put(item) {
      if (!item || !item.id) throw new Error("board.put requires an item with an id");
      items.set(item.id, copy(item));
    },

    remove(id) {
      items.delete(id);
    },

    list(filter = {}) {
      let out = [...items.values()].map(copy);
      if (filter.role !== undefined) out = out.filter((it) => matchRole(it, filter.role!));
      if (filter.status) out = out.filter((it) => it.status === filter.status);
      if (filter.engagementId) out = out.filter((it) => it.engagementId === filter.engagementId);
      if (filter.open === true) out = out.filter((it) => it.status !== "closed");
      out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const limit = Number.isInteger(filter.limit) && (filter.limit ?? 0) > 0 ? filter.limit! : 0;
      return limit ? out.slice(0, limit) : out;
    },

    summary() {
      const byStatus: Record<string, number> = {};
      for (const item of items.values()) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      return { total: items.size, byStatus };
    },

    clear() {
      items.clear();
    },
  };
};
