import { resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
// apps/backend/__tests__/terminology-routes-mount.test.ts — FB-T01 composition-root mount glue.
//
// Proves `mountTerminologyRoutes(app, db)` wires the M38 read surface onto the host behind the same
// auth/security chain as every other module route — so the Terminology Admin screen reaches a live
// endpoint instead of a 404. Route REGISTRATION never touches the DB (the Drizzle store only closes
// over the handle; queries happen at request time), so a stub DbClient exercises the wiring without
// live Postgres. The deep store reads are covered by the route inventory tests over the in-memory
// provider (terminology-routes.test.ts) and by the live RLS suite (rls-isolation.live.test.ts).
import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountTerminologyRoutes } from "../src/modules/38-terminology/index";

// A handle that is never queried during registration — passing it proves the mount glue is pure.
const STUB_DB = {} as DbClient;

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("FB-T01 mountTerminologyRoutes (composition-root glue)", () => {
  it("mounts the read surface behind the auth chain (401 unauthenticated, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountTerminologyRoutes(app, STUB_DB);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminology/icd10cm/search?q=heart",
    });
    expect(res.statusCode).toBe(401); // route exists + is gated; a 404 would mean it never mounted
    await app.close();
  });

  it("exposes no canonical-write route (§7.4 lockdown — the mount adds only the read surface + extensions)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountTerminologyRoutes(app, STUB_DB);
    const forge = await app.inject({
      method: "POST",
      url: "/api/v1/terminology/icd10cm/I99.9",
      payload: { display: "forged concept" },
    });
    expect(forge.statusCode).toBe(404);
    await app.close();
  });

  it("does not serve the routes when the mount hook is not invoked (404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/terminology/icd10cm/search?q=heart",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
