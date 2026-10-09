// GAP-034 — the two single-resource eligibility reads must name a patient, or the read-audit event
// (resource_id is a uuid column) fails its insert and is silently swallowed.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerEligibilityRoutes } from "../routes/eligibility.routes";

describe("eligibility read-audit config", () => {
  it("gives hospice-periods and latest a patientIdQueryParam so the audit resource id resolves", async () => {
    const app = Fastify();
    const configs = new Map<string, Record<string, unknown> | undefined>();
    app.addHook("onRoute", (route) => {
      if (route.method === "GET") {
        configs.set(
          route.url,
          (route.config as { auditRead?: Record<string, unknown> } | undefined)?.auditRead,
        );
      }
    });
    registerEligibilityRoutes(app, { readService: {} as never, writeService: {} as never });

    for (const url of [
      "/api/v1/billing/eligibility/hospice-periods",
      "/api/v1/billing/eligibility/latest",
    ]) {
      const cfg = configs.get(url);
      expect(cfg, url).toBeDefined();
      expect(cfg?.patientIdQueryParam ?? cfg?.resourceIdParam, url).toBeTruthy();
    }
    await app.close();
  });
});
