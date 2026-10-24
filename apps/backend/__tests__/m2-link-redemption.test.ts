/**
 * M2 collaborator / funeral-home link redemption - the pure parts and the route's fail-closed branches over fakes.
 * The end-to-end proof (single use, expiry, replay, cross-tenant, concurrency, cookie, RLS) is
 * `m2-link-redemption.live.test.ts`.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { funeralSessionPinnedPatientPredicate } from "../src/modules/02-identity/abac-predicates";
import {
  hashLinkToken,
  mintLinkToken,
  organizationOfLinkToken,
} from "../src/modules/02-identity/collaborator-link-store-db";
import {
  type CollaboratorLinkStore,
  type IdentityRouteDeps,
  LinkError,
} from "../src/modules/02-identity/identity-ports";
import { createLinkDelivery } from "../src/modules/02-identity/link-delivery";
import { registerLinkRoutes } from "../src/modules/02-identity/routes/link-routes";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";

describe("link token", () => {
  it("is <org>.<256-bit url-safe secret>, unique per mint, and the org prefix round-trips", () => {
    const a = mintLinkToken(ORG);
    const b = mintLinkToken(ORG);
    expect(a).toMatch(new RegExp(`^${ORG}\\.[A-Za-z0-9_-]{43}$`));
    expect(a).not.toBe(b);
    expect(organizationOfLinkToken(a)).toBe(ORG);
  });

  it("hashes to a stable 64-hex digest that never contains the secret", () => {
    const token = mintLinkToken(ORG);
    const digest = hashLinkToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(hashLinkToken(token));
    expect(digest).not.toContain(token.split(".")[1]);
    expect(hashLinkToken(`${token}x`)).not.toBe(digest);
  });

  it.each([
    "",
    "x",
    "garbage",
    `${ORG}.short`,
    `${ORG}.${"A".repeat(44)}`,
    `${ORG}.${"A".repeat(42)}`,
    `not-a-uuid.${"A".repeat(43)}`,
    `${ORG}.${"A".repeat(42)}!`,
  ])("rejects a malformed token %j before it can name a tenant", (bad) => {
    expect(organizationOfLinkToken(bad)).toBeNull();
  });
});

describe("funeral link delivery", () => {
  it("puts the token in the URL FRAGMENT (never the query), names no patient, and sends once", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const delivery = createLinkDelivery({
      transport: { send: async (m) => void sent.push(m) },
      baseUrl: "https://portal.test/",
    });
    await delivery.deliver({
      kind: "funeral_home",
      organizationId: ORG,
      email: "d@home.test",
      token: "tok.en/+=",
      expiresAt: new Date("2026-10-10T00:00:00Z"),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("https://portal.test/funeral/redeem#token=tok.en%2F%2B%3D");
    expect(sent[0]?.text).not.toContain("?token=");
    expect(sent[0]?.text).not.toMatch(/patient|deceased|decedent/i);
    await delivery.deliver({
      kind: "external_collaborator",
      organizationId: ORG,
      email: "c@x.test",
      token: "t",
      expiresAt: new Date(),
    });
    expect(sent[1]?.text).toContain("/collaborator/redeem#token=t");
  });

  it("lands on the organization's own portal base when one is resolved, else the global base", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const delivery = createLinkDelivery({
      transport: { send: async (m) => void sent.push(m) },
      baseUrl: "https://portal.test/",
      baseUrlFor: async (orgId) =>
        orgId === ORG ? "https://acme.chartwarden.com/portal" : undefined,
    });
    const input = {
      kind: "funeral_home",
      email: "d@home.test",
      token: "t",
      expiresAt: new Date(),
    } as const;
    await delivery.deliver({ ...input, organizationId: ORG });
    await delivery.deliver({ ...input, organizationId: "other-org" });
    expect(sent[0]?.text).toContain("https://acme.chartwarden.com/portal/funeral/redeem#token=t");
    expect(sent[1]?.text).toContain("https://portal.test/funeral/redeem#token=t");
  });
});

describe("funeral_session_pinned_patient", () => {
  const ctx = (attributes: Record<string, unknown>, organizationId = ORG) =>
    ({ organizationId, userId: "u", roles: [], attributes }) as never;
  it("allows only a funeral_home session reading the patient it is pinned to", async () => {
    const ok = ctx({ sessionClass: "funeral_home", sessionPatientId: PATIENT });
    expect(await funeralSessionPinnedPatientPredicate(ok, { patientId: PATIENT })).toBe(true);
    expect(await funeralSessionPinnedPatientPredicate(ok, { patientId: "other" })).toBe(false);
    expect(await funeralSessionPinnedPatientPredicate(ok, {})).toBe(false);
  });
  it("denies every other class, an unpinned session and a session with no tenant", async () => {
    for (const sessionClass of [
      "staff",
      "external_collaborator",
      "caregiver_portal",
      "auditor",
      undefined,
    ]) {
      expect(
        await funeralSessionPinnedPatientPredicate(
          ctx({ sessionClass, sessionPatientId: PATIENT }),
          {
            patientId: PATIENT,
          },
        ),
      ).toBe(false);
    }
    expect(
      await funeralSessionPinnedPatientPredicate(ctx({ sessionClass: "funeral_home" }), {
        patientId: PATIENT,
      }),
    ).toBe(false);
    expect(
      await funeralSessionPinnedPatientPredicate(
        ctx({ sessionClass: "funeral_home", sessionPatientId: PATIENT }, ""),
        { patientId: PATIENT },
      ),
    ).toBe(false);
  });
});

describe("POST /api/v1/collaborators/consume over a durable-shaped store", () => {
  function build(over: {
    consume: CollaboratorLinkStore["consume"];
    minter?: IdentityRouteDeps["linkSessions"];
    stillDeceased?: boolean;
  }) {
    const released: string[] = [];
    const audited: string[] = [];
    const app = Fastify();
    app.decorateRequest("context", null as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        userId: "",
        organizationId: "",
        correlationId: "c",
        ip: "127.0.0.1",
        userAgent: "t",
        attributes: {},
      };
    });
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { code?: string; statusCode?: number };
      void reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? "ERR" } });
    });
    registerLinkRoutes(app, {
      collaborators: {
        create: async () => ({ linkId: "l", expiresAt: "x" }),
        consume: over.consume,
        release: async ({ linkId }: { linkId: string }) => void released.push(linkId),
      },
      sessions: { revokeAllForUser: async () => 0 },
      deceasedPatients: { isDeceased: async () => over.stillDeceased ?? true },
      audit: {
        insert: () => ({
          values: (row: { eventType?: string }) => {
            audited.push(String(row.eventType));
            return Promise.resolve();
          },
        }),
      },
      ...(over.minter ? { linkSessions: over.minter } : {}),
    } as never);
    return { app, released, audited };
  }
  const scope = {
    organizationId: ORG,
    patientId: PATIENT,
    kind: "funeral_home" as const,
    linkId: "33333333-3333-4333-8333-333333333333",
    principalUserId: "44444444-4444-4444-8444-444444444444",
    sessionTtlSec: 3600,
    useCount: 1,
  };
  const call = (app: ReturnType<typeof build>["app"], body: unknown = { token: "t" }) =>
    app.inject({ method: "POST", url: "/api/v1/collaborators/consume", payload: body as never });

  it("a durable link with no session minter bound gives the use back and answers 503 (the token is not burned)", async () => {
    const { app, released } = build({ consume: async () => scope });
    const res = await call(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("LINK_SESSION_UNAVAILABLE");
    expect(released).toEqual([scope.linkId]);
  });

  it("maps used -> 409 and expired/revoked/unknown -> 410, and audits only a KNOWN link", async () => {
    const used = build({
      consume: async () => {
        throw new LinkError("used", "x", {
          linkId: scope.linkId,
          organizationId: ORG,
          kind: "funeral_home",
          reason: "used",
        });
      },
    });
    expect((await call(used.app)).statusCode).toBe(409);
    expect(used.audited).toContain("m2.link.redemption_refused");
    const unknown = build({
      consume: async () => {
        throw new LinkError("expired", "x");
      },
    });
    expect((await call(unknown.app)).statusCode).toBe(410);
    expect(unknown.audited).toEqual([]);
  });

  it("re-proves eligibility at redemption: a no-longer-deceased patient is 410, the use handed back, and no session is minted", async () => {
    let minted = 0;
    const { app, released, audited } = build({
      consume: async () => scope,
      stillDeceased: false,
      minter: {
        mint: async () => {
          minted += 1;
          return { sessionId: "s", setCookies: ["a=b"] };
        },
      },
    });
    const res = await call(app);
    expect(res.statusCode).toBe(410);
    expect(minted).toBe(0);
    expect(released).toEqual([scope.linkId]);
    expect(audited).toContain("m2.link.redemption_refused");
  });

  it("a minter that throws gives the use back; success sets the cookie and returns no token and no session id", async () => {
    const failing = build({
      consume: async () => scope,
      minter: {
        mint: async () => {
          throw new Error("boom");
        },
      },
    });
    expect((await call(failing.app)).statusCode).toBe(503);
    expect(failing.released).toEqual([scope.linkId]);

    const good = build({
      consume: async () => scope,
      minter: {
        mint: async () => ({
          sessionId: "sess-1",
          setCookies: ["wx_session=abc; Path=/; HttpOnly"],
        }),
      },
    });
    const res = await call(good.app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toEqual(["wx_session=abc; Path=/; HttpOnly"]);
    expect(res.json()).toMatchObject({
      sessionClass: "funeral_home",
      scope: { patientId: PATIENT },
    });
    expect(JSON.stringify(res.json())).not.toContain("sess-1");
    expect(good.released).toEqual([]);
  });

  it("a body without a token is a 422 validation error and consumes nothing", async () => {
    let touched = false;
    const { app } = build({
      consume: async () => {
        touched = true;
        return scope;
      },
    });
    expect((await call(app, {})).statusCode).toBe(422);
    expect(touched).toBe(false);
  });
});
