// apps/backend/src/bootstrap/routes/system.ts — M1 system-status + feature-flag routes
// (spec §4.1–4.2, §6; M1-T10).
//
// GET routes require a session; the admin status mutation is platform_ops-only. As of M3-T10
// these guards are the REAL Authorization Contract (`requireSession`/`requireRole` from
// @wardenx/auth, a foundation-helper package every module may consume) — the M1 deny-stub
// forward-seam is retired. Data access goes through injected readers (the seam to M1's own
// `system_status` / `feature_flag` tables) so the route file imports no Drizzle schema
// directly; the boot default is an in-memory reader (the slice has no DB wired yet), which
// production swaps for the org-scoped, withOrgContext-wrapped DB reader.
import { requireRole, requireSession } from "@wardenx/auth";
import { ValidationError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

export type SystemStatusLevel = "operational" | "degraded" | "outage";

export interface SystemStatusComponent {
  id: string;
  status: SystemStatusLevel;
  headline: string | null;
  details: string | null;
  updatedAt: string;
}

/** Reader/writer port over M1's `system_status` table (org-scoped in production). */
export interface SystemStatusReader {
  list(orgId: string): Promise<SystemStatusComponent[]>;
  upsert(orgId: string, component: SystemStatusComponent): Promise<void>;
}

/** Reader port over M1's `feature_flag` table — resolved flags for an org. */
export interface FeatureFlagReader {
  forOrg(orgId: string): Promise<Record<string, boolean>>;
}

const STATUS_LEVELS: readonly SystemStatusLevel[] = ["operational", "degraded", "outage"];

/** The role that may mutate system status (spec §6 permissions matrix). */
export const PLATFORM_OPS_ROLE = "platform_ops";

export function registerSystemRoutes(
  app: FastifyInstance,
  deps: { statusReader: SystemStatusReader; flagReader: FeatureFlagReader },
): void {
  app.get("/api/v1/system/status", async (request, reply) => {
    await requireSession()(request);
    const components = await deps.statusReader.list(request.context.organizationId);
    return reply.send({ components });
  });

  app.get("/api/v1/system/feature-flags", async (request, reply) => {
    await requireSession()(request);
    const flags = await deps.flagReader.forOrg(request.context.organizationId);
    return reply.send({ flags });
  });

  app.post("/api/v1/admin/system/status", async (request, reply) => {
    await requireRole(PLATFORM_OPS_ROLE)(request);
    const component = parseStatusComponent(request.body);
    await deps.statusReader.upsert(request.context.organizationId, component);
    const components = await deps.statusReader.list(request.context.organizationId);
    return reply.code(200).send({ components });
  });
}

function parseStatusComponent(body: unknown): SystemStatusComponent {
  const details: { field?: string; code: string; message: string }[] = [];
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  if (typeof b.id !== "string" || b.id.length === 0) {
    details.push({ field: "id", code: "REQUIRED", message: "id is required" });
  }
  if (typeof b.status !== "string" || !STATUS_LEVELS.includes(b.status as SystemStatusLevel)) {
    details.push({
      field: "status",
      code: "INVALID",
      message: `status must be one of ${STATUS_LEVELS.join(", ")}`,
    });
  }
  if (details.length > 0) throw new ValidationError("invalid system status component", details);

  return {
    id: b.id as string,
    status: b.status as SystemStatusLevel,
    headline: typeof b.headline === "string" ? b.headline : null,
    details: typeof b.details === "string" ? b.details : null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * In-memory SystemStatusReader — the slice default. Org-scoped map; production injects the
 * Drizzle reader that runs inside withOrgContext so RLS scopes `system_status` by app.org_id.
 */
export function createInMemorySystemStatusReader(): SystemStatusReader {
  const byOrg = new Map<string, Map<string, SystemStatusComponent>>();
  return {
    async list(orgId) {
      return [...(byOrg.get(orgId)?.values() ?? [])];
    },
    async upsert(orgId, component) {
      const map = byOrg.get(orgId) ?? new Map<string, SystemStatusComponent>();
      map.set(component.id, component);
      byOrg.set(orgId, map);
    },
  };
}

/** Default FeatureFlagReader — no flags set (Phase-1 scope flags stay default-off). */
export function createDefaultFeatureFlagReader(): FeatureFlagReader {
  return {
    async forOrg() {
      return {};
    },
  };
}
