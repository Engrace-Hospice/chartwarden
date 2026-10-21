// M2/M3 auditor link redemption — the pure / port-level units (the database behaviour is proven in
// m2-auditor-redemption.live.test.ts).
import { createHmac } from "node:crypto";
import {
  AuditorSessionIssueError,
  createAuditorSessionIssuer,
  signSessionCookieValue,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";
import {
  buildAuditorRedeemUrl,
  createAuditorLinkEmailDelivery,
} from "../src/modules/02-identity/auditor-link-delivery";
import {
  auditorTokenHashMatches,
  classifyAuditorLink,
  generateAuditorToken,
  hashAuditorToken,
} from "../src/modules/02-identity/auditor-magic-link-store";
import { auditorRefusalError } from "../src/modules/02-identity/auditor-redemption";

const T0 = new Date("2026-10-07T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("classifyAuditorLink", () => {
  const live = { windowStart: at(-60), expiresAt: at(60), consumedAt: null, revokedAt: null };

  it("is live only inside the window and while unconsumed and unrevoked", () => {
    expect(classifyAuditorLink(live, T0)).toBe("live");
    expect(classifyAuditorLink(live, at(-61))).toBe("not_yet_open");
    expect(classifyAuditorLink(live, at(60))).toBe("expired"); // end is exclusive
    expect(classifyAuditorLink({ ...live, consumedAt: at(-1) }, T0)).toBe("consumed");
    expect(classifyAuditorLink({ ...live, revokedAt: at(-1) }, T0)).toBe("revoked");
  });

  it("reports revoked before consumed before expired (the most specific cause wins)", () => {
    const dead = {
      windowStart: at(-120),
      expiresAt: at(-60),
      consumedAt: at(-90),
      revokedAt: at(-80),
    };
    expect(classifyAuditorLink(dead, T0)).toBe("revoked");
    expect(classifyAuditorLink({ ...dead, revokedAt: null }, T0)).toBe("consumed");
    expect(classifyAuditorLink({ ...dead, revokedAt: null, consumedAt: null }, T0)).toBe("expired");
  });
});

describe("auditorTokenHashMatches (constant-time digest comparison)", () => {
  const token = generateAuditorToken();
  const hash = hashAuditorToken(token);

  it("matches the digest of the same token only", () => {
    expect(auditorTokenHashMatches(hash, hashAuditorToken(token))).toBe(true);
    expect(auditorTokenHashMatches(hash, hashAuditorToken(generateAuditorToken()))).toBe(false);
  });

  it("refuses malformed or differently-sized values instead of comparing them", () => {
    expect(auditorTokenHashMatches(hash, hash.slice(2))).toBe(false);
    expect(auditorTokenHashMatches("", "")).toBe(false);
    expect(auditorTokenHashMatches("zz", "zz")).toBe(false); // not hex
  });
});

describe("auditorRefusalError", () => {
  it("maps each refusal to the typed envelope and hides unknown-vs-revoked", () => {
    const code = (r: Parameters<typeof auditorRefusalError>[0]) => {
      const e = auditorRefusalError(r);
      return [e.code, e.statusCode];
    };
    expect(code("consumed")).toEqual(["LINK_ALREADY_USED", 409]);
    expect(code("expired")).toEqual(["LINK_EXPIRED", 410]);
    expect(code("not_yet_open")).toEqual(["ENGAGEMENT_NOT_OPEN", 403]);
    expect(code("engagement_not_active")).toEqual(["ENGAGEMENT_NOT_ACTIVE", 403]);
    expect(code("identity_is_member")).toEqual(["AUDITOR_IDENTITY_IS_MEMBER", 409]);
    expect(code("role_over_privileged")).toEqual(["AUDITOR_ROLE_MISCONFIGURED", 403]);
    expect(code("unknown_link")).toEqual(["LINK_INVALID", 410]);
    expect(code("revoked")).toEqual(code("unknown_link"));
  });
});

describe("auditor link delivery", () => {
  const link = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    engagementId: "e1",
    auditorName: "Ada",
    auditorEmail: "ada@survey.test",
    token: generateAuditorToken(),
    expiresAt: at(60),
  };

  it("builds a link whose token rides the URL FRAGMENT (never the query string)", () => {
    const url = new URL(
      buildAuditorRedeemUrl("https://app.example.test/", link.organizationId, link.token),
    );
    expect(url.pathname).toBe("/auditor/redeem");
    expect(url.searchParams.get("org")).toBe(link.organizationId);
    expect(url.search).not.toContain(link.token);
    expect(url.hash).toBe(`#token=${link.token}`);
  });

  it("emails the link to the auditor", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const delivery = createAuditorLinkEmailDelivery({
      transport: { send: async (m) => void sent.push(m) },
      baseUrl: "https://app.example.test",
    });
    await delivery.deliver(link);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ada@survey.test");
    expect(sent[0]?.text).toContain(`#token=${link.token}`);
  });

  it("uses the organization's own origin when one resolves", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const delivery = createAuditorLinkEmailDelivery({
      transport: { send: async (m) => void sent.push(m) },
      baseUrl: undefined,
      baseUrlFor: async () => "https://acme.chartwarden.com",
    });
    await delivery.deliver(link);
    expect(sent[0]?.text).toContain("https://acme.chartwarden.com/auditor/redeem?org=");
  });

  it("FAILS CLOSED without a web origin (and never puts the token in the error)", async () => {
    const delivery = createAuditorLinkEmailDelivery({
      transport: { send: async () => undefined },
      baseUrl: undefined,
    });
    const err = await delivery.deliver(link).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(link.token);
  });
});

describe("createAuditorSessionIssuer", () => {
  const SECRET = "test-secret-at-least-32-characters-long-xx";
  const created: Array<{
    userId: string;
    override: Record<string, unknown>;
    overrideAll: boolean;
  }> = [];
  const auth = {
    $context: Promise.resolve({
      secret: SECRET,
      authCookies: {
        sessionToken: {
          name: "better-auth.session_token",
          attributes: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
        },
      },
      internalAdapter: {
        async createSession(
          userId: string,
          _remember?: boolean,
          override?: Record<string, unknown>,
          all?: boolean,
        ) {
          created.push({ userId, override: override ?? {}, overrideAll: all === true });
          return {
            id: "sess-1",
            token: "tok-abc",
            expiresAt: (override?.expiresAt as Date) ?? new Date(),
          };
        },
      },
    }),
  };

  it("signs the cookie exactly as Better Auth does (token.base64(HMAC-SHA256))", () => {
    const signature = createHmac("sha256", SECRET).update("tok-abc").digest("base64");
    expect(signSessionCookieValue("tok-abc", SECRET)).toBe(
      encodeURIComponent(`tok-abc.${signature}`),
    );
  });

  it("mints an auditor-class session bounded by the window, scoped to ONE engagement", async () => {
    const issued = await createAuditorSessionIssuer(auth).issue({
      userId: "u1",
      organizationId: "o1",
      engagementId: "e1",
      windowStart: at(-60),
      windowEnd: at(60),
      now: T0,
    });
    const call = created.at(-1);
    expect(call?.overrideAll).toBe(true);
    expect(call?.override).toMatchObject({
      activeOrganizationId: "o1",
      sessionClass: "auditor",
      scope: { engagementId: "e1" },
      engagementStart: at(-60),
      engagementEnd: at(60),
      expiresAt: at(60), // never outlives the engagement
    });
    expect(issued.expiresAt).toEqual(at(60));
    expect(issued.setCookie).toContain("better-auth.session_token=tok-abc");
    expect(issued.setCookie).toContain("Max-Age=3600");
    expect(issued.setCookie).toContain("HttpOnly");
    expect(issued.setCookie).toContain("SameSite=Lax");
    expect(issued.setCookie).not.toContain("Secure");
  });

  it("refuses to mint once the window has ended", async () => {
    await expect(
      createAuditorSessionIssuer(auth).issue({
        userId: "u1",
        organizationId: "o1",
        engagementId: "e1",
        windowStart: at(-120),
        windowEnd: at(-1),
        now: T0,
      }),
    ).rejects.toBeInstanceOf(AuditorSessionIssueError);
  });
});

describe("authenticate hook — auditor sessions are read-only and stage-gated", () => {
  const actor = (sessionClass: string, auditorStage: "enrolment" | "active" | null = "active") => ({
    sessionClass,
    portalAccountId: null,
    sessionPatientId: null,
    deviceAttestation: null,
    externalActorId: null,
    engagementId: "e1",
    auditorStage,
    userId: "u1",
    membershipId: null,
    organizationId: "org1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
  });
  const run = async (
    sessionClass: string,
    method: string,
    url: string,
    stage: "enrolment" | "active" | null = "active",
  ) => {
    const ctx = {
      userId: "",
      organizationId: "",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      attributes: {} as Record<string, unknown>,
    };
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () =>
        ({
          resolveActor: async () => actor(sessionClass, stage),
          resolveStepUpState: async () => null,
          resolveStepUpPolicy: async () => ({ qualifyingFactors: ["totp"], maxAgeSec: 300 }),
        }) as never,
    });
    await hook({ context: ctx, headers: {}, method, url } as unknown as FastifyRequest);
    return ctx;
  };

  it("lets an ACTIVE auditor read", async () => {
    await expect(run("auditor", "GET", "/api/v1/x")).resolves.toBeTruthy();
    await expect(run("auditor", "HEAD", "/api/v1/x")).resolves.toBeTruthy();
  });

  it("refuses every write for an ACTIVE auditor, with the typed code", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(run("auditor", method, "/api/v1/x")).rejects.toMatchObject({
        code: "AUDITOR_READ_ONLY",
        statusCode: 403,
      });
    }
  });

  it("an active auditor cannot call the enrolment mutations (read-only wins)", async () => {
    await expect(run("auditor", "POST", "/api/v1/auditors/enrolment/baa")).rejects.toMatchObject({
      code: "AUDITOR_READ_ONLY",
    });
    await expect(run("auditor", "GET", "/api/v1/auditors/enrolment/state")).resolves.toBeTruthy();
  });

  it("allows only sign-out and a second link redemption as ACTIVE auditor mutations", async () => {
    await expect(run("auditor", "POST", "/api/auth/sign-out")).resolves.toBeTruthy();
    await expect(run("auditor", "POST", "/api/v1/auditors/redeem?x=1")).resolves.toBeTruthy();
    await expect(run("auditor", "POST", "/api/auth/change-email")).rejects.toMatchObject({
      code: "AUDITOR_READ_ONLY",
    });
  });

  it("an ENROLMENT-stage auditor reaches exactly the enrolment routes, sign-out and redemption", async () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/v1/auth/csrf"],
      ["GET", "/api/v1/auditors/enrolment/state"],
      ["POST", "/api/v1/auditors/enrolment/baa"],
      ["POST", "/api/v1/auditors/enrolment/totp/begin"],
      ["POST", "/api/v1/auditors/enrolment/totp/confirm"],
      ["POST", "/api/v1/auditors/enrolment/verify?x=1"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/v1/auditors/redeem"],
    ];
    for (const [method, url] of allowed) {
      await expect(run("auditor", method, url, "enrolment")).resolves.toBeTruthy();
    }
  });

  it("an ENROLMENT-stage auditor cannot reach the engagement read or any other route", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/auditor/portal-engagement/e1"],
      ["GET", "/api/v1/patients"],
      ["POST", "/api/v1/x"],
      ["GET", "/api/v1/auditors/enrolment/baa"],
      ["POST", "/api/v1/auditors/enrolment/state"],
      ["POST", "/api/v1/auditors/enrolment/other"],
    ] as const) {
      await expect(run("auditor", method, url, "enrolment")).rejects.toMatchObject({
        code: "AUDITOR_ENROLMENT_REQUIRED",
        statusCode: 403,
      });
    }
  });

  it("FAILS CLOSED: an auditor whose stage is unresolved is treated as enrolment", async () => {
    await expect(run("auditor", "GET", "/api/v1/x", null)).rejects.toMatchObject({
      code: "AUDITOR_ENROLMENT_REQUIRED",
    });
  });

  it("stamps the engagement READ scope only for an active session", async () => {
    const active = await run("auditor", "GET", "/api/v1/x", "active");
    expect(active.attributes.engagementId).toBe("e1");
    expect(active.attributes.auditorEnrolmentEngagementId).toBe("e1");
    const enrolling = await run("auditor", "GET", "/api/v1/auditors/enrolment/state", "enrolment");
    expect(enrolling.attributes.engagementId).toBeUndefined();
    expect(enrolling.attributes.auditorEnrolmentEngagementId).toBe("e1");
    expect(enrolling.attributes.auditorStage).toBe("enrolment");
  });

  it("does not restrict any other session class", async () => {
    await expect(run("staff", "POST", "/api/v1/x", null)).resolves.toBeTruthy();
  });
});
