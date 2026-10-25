// #714 (S14) - a clearinghouse credential rejected at runtime (HTTP 401/403) fails safe: a degraded result with a
// stable code, one alert, no retry storm toward the vendor, nothing sensitive in any result, log or alert, and no
// effect on another tenant. Real StediTransport / DirectMacTransport behind the real worker functions; no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CH,
  type ClearinghouseBinding,
  type ClearinghouseContext,
  CredentialRejectedError,
  DirectMacTransport,
  InMemoryAttemptStore,
  StediTransport,
  UploadNotSentError,
} from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_HOLD_MS,
  CREDENTIAL_REJECTED_ALERT,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-credential-guard";
import {
  type M23TransportDeps,
  pullTransportAcks,
  transportUpload,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";
import { buildDirectMacGateway } from "../src/modules/23-billing-medicare/jobs/direct-mac-gateway";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "33333333-3333-3333-3333-333333333333";
const PE_A = "22222222-2222-2222-2222-222222222222";
const PE_B = "44444444-4444-4444-4444-444444444444";
const KEY = "stedi-key-SENTINEL-0001";
const REJECTED = "Stedi rejected the platform credential";
const MBI = "1EG4TE5MK73"; // synthetic
const BODY_SECRET = "echoed-body-SENTINEL";

const fixture = (name: string): string =>
  readFileSync(
    join(__dirname, "../../../packages/x12-837-client/src/clearinghouse/__fixtures__", name),
    "utf8",
  );
const withIsa13 = (x12: string, cn: string): string =>
  x12.replace(/^(ISA(?:\*[^*]*){12}\*)[^*]*/, `$1${cn}`);
const CLAIM_X12 = `${withIsa13(fixture("stedi-claim.x12"), "000000001")}\nREF*SY*${MBI}~`;

const ctxFor = (org: string, pe: string): ClearinghouseContext => ({
  organizationId: org,
  providerEntityId: pe,
  payerId: "ngs_j6",
  correlationId: "corr",
  usage: "test",
  jurisdiction: "ngs_j6",
});

interface Captured {
  readonly logs: string[];
  readonly alerts: { alertCode: string; organizationId: string; payload: unknown }[];
  clock: number;
}

function deps(
  binding: ClearinghouseBinding,
  entities: readonly (readonly [string, string])[] = [[ORG_A, PE_A]],
) {
  const captured: Captured = { logs: [], alerts: [], clock: Date.parse("2026-10-11T10:00:00Z") };
  const d: M23TransportDeps = {
    binding,
    contexts: {
      contextFor: async (org, pe) => ctxFor(org, pe),
      providerEntitiesFor: async (org) => entities.filter(([o]) => o === org).map(([, p]) => p),
    },
    alerts: {
      dispatch: async (a) => {
        captured.alerts.push(a);
      },
    },
    logger: { error: (f, m) => captured.logs.push(JSON.stringify([f, m])) },
    now: () => captured.clock,
  };
  return { d, captured };
}

const upload = (d: M23TransportDeps, org = ORG_A, pe = PE_A, controlNumber = "000000001") =>
  transportUpload(d)({
    organizationId: org,
    providerEntityId: pe,
    kind: "claim_837i",
    x12: withIsa13(CLAIM_X12, controlNumber),
    controlNumber,
  });

const everything = (captured: Captured, extra: unknown) =>
  JSON.stringify([captured.logs, captured.alerts, String(extra)]);

describe("Stedi credential rejected at runtime", () => {
  for (const status of [401, 403]) {
    it(`HTTP ${status}: stable code, one alert, one vendor call across retries, nothing sensitive`, async () => {
      let calls = 0;
      const stedi = new StediTransport({
        apiKey: KEY,
        attempts: new InMemoryAttemptStore(),
        fetch: (async () => {
          calls += 1;
          return new Response(JSON.stringify({ message: `bad key ${KEY} ${MBI} ${BODY_SECRET}` }), {
            status,
          });
        }) as typeof fetch,
      });
      const { d, captured } = deps({ vendor: "stedi", transport: stedi });

      const errors: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await upload(d).catch((e: Error) => errors.push(e.message));
      }

      expect(errors).toHaveLength(4);
      for (const m of errors) expect(m).toContain(`(${CH.NOT_WIRED})`);
      expect(calls).toBe(1); // the retries are held, not sent
      expect(captured.alerts).toHaveLength(1);
      expect(captured.alerts[0]).toMatchObject({
        alertCode: CREDENTIAL_REJECTED_ALERT,
        organizationId: ORG_A,
      });
      const blob = everything(captured, errors.join("|"));
      for (const secret of [KEY, MBI, BODY_SECRET, "NM1*IL", "ISA*"]) {
        expect(blob).not.toContain(secret);
      }

      // after the hold the vendor is probed again (the credential may have been fixed), alerting once more if not
      captured.clock += CREDENTIAL_HOLD_MS + 1;
      await upload(d).catch(() => undefined);
      expect(calls).toBe(2);
      expect(captured.alerts).toHaveLength(2);
    });
  }
});

describe("a non-credential CH_NOT_WIRED does not look like a rejected credential", () => {
  it("Stedi's unimplemented ack pull raises no alert and does not hold submits", async () => {
    let calls = 0;
    const stedi = new StediTransport({
      apiKey: KEY,
      attempts: new InMemoryAttemptStore(),
      fetch: (async () => {
        calls += 1;
        return Response.json({ status: "SUCCESS", claimReference: { correlationId: "c-1" } });
      }) as typeof fetch,
    });
    const { d, captured } = deps({ vendor: "stedi", transport: stedi });
    const pull = await pullTransportAcks(d, ORG_A, "ack_999", async () => undefined);
    expect(pull.failures).toHaveLength(1);
    expect(captured.alerts).toEqual([]);
    await expect(upload(d)).resolves.toMatchObject({ accepted: true });
    expect(calls).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("one tenant's rejected credential does not hold or fail another tenant's submit or ack pull", async () => {
    const seen: string[] = [];
    const rejecting = (org: string) => org === ORG_A;
    const fake = {
      submitClaim: async (ctx: ClearinghouseContext) => {
        seen.push(ctx.organizationId);
        return rejecting(ctx.organizationId)
          ? { ok: false, degraded: { code: CH.NOT_WIRED, reason: REJECTED } }
          : {
              ok: true,
              data: {
                clearinghouseSubmissionId: "s-1",
                controlNumber: "c",
                idempotencyKey: "k",
                replayed: false,
              },
            };
      },
      fetchAcknowledgments: async (ctx: ClearinghouseContext) =>
        rejecting(ctx.organizationId)
          ? { ok: false, degraded: { code: CH.NOT_WIRED, reason: REJECTED } }
          : { ok: true, data: { items: [], nextCursor: "0", hasMore: false } },
    };
    const { d, captured } = deps({ vendor: "stedi", transport: fake as never }, [
      [ORG_A, PE_A],
      [ORG_B, PE_B],
    ]);

    await expect(upload(d, ORG_A, PE_A)).rejects.toThrow(CH.NOT_WIRED);
    await expect(upload(d, ORG_A, PE_A)).rejects.toThrow(CH.NOT_WIRED); // held
    await expect(upload(d, ORG_B, PE_B)).resolves.toMatchObject({ accepted: true });
    expect(seen).toEqual([ORG_A, ORG_B]);

    const pullA = await pullTransportAcks(d, ORG_A, "ack_999", async () => undefined);
    const pullB = await pullTransportAcks(d, ORG_B, "ack_999", async () => undefined);
    expect(pullA.failures).toHaveLength(1);
    expect(pullA.failures[0]).toContain(CH.NOT_WIRED);
    expect(pullB.failures).toEqual([]);
    expect(captured.alerts.map((a) => a.organizationId)).toEqual([ORG_A]);
  });

  it("a failing alert router never masks the degraded result", async () => {
    const fake = {
      submitClaim: async () => ({ ok: false, degraded: { code: CH.NOT_WIRED, reason: REJECTED } }),
    };
    const { d, captured } = deps({ vendor: "stedi", transport: fake as never });
    const broken: M23TransportDeps = {
      ...d,
      alerts: {
        dispatch: async () => {
          throw new Error("router down");
        },
      },
    };
    await expect(upload(broken)).rejects.toThrow(CH.NOT_WIRED);
    expect(captured.logs.join()).toContain("could not be dispatched");
  });
});

describe("MAC credential rejected at runtime (direct_mac)", () => {
  const portal = (status: number, uploads: string[]) =>
    ({
      upload: async (i: { controlNumber: string }) => {
        uploads.push(i.controlNumber);
        throw new Error(`Medicare gateway returned HTTP ${status}`);
      },
      pullPending999: async () => {
        throw new Error(`Medicare gateway returned HTTP ${status}`);
      },
      pullPending277ca: async () => [],
    }) as never;
  const x12 = { parse999: async () => [], parse277ca: async () => [] } as never;

  it("the gateway tells a rejected credential from a plain 4xx refusal", async () => {
    const uploads: string[] = [];
    const args = {
      kind: "claim" as const,
      organizationId: ORG_A,
      providerEntityId: PE_A,
      controlNumber: "000000001",
      x12: "X",
    };
    for (const status of [401, 403]) {
      const gw = buildDirectMacGateway({
        x12,
        macPortal: portal(status, uploads),
        controlNumberOf: async () => null,
      });
      await expect(gw.upload(args)).rejects.toBeInstanceOf(CredentialRejectedError);
      await expect(gw.pullAcknowledgments(ctxFor(ORG_A, PE_A))).rejects.toBeInstanceOf(
        CredentialRejectedError,
      );
    }
    const refused = buildDirectMacGateway({
      x12,
      macPortal: portal(422, uploads),
      controlNumberOf: async () => null,
    });
    await expect(refused.upload(args)).rejects.toBeInstanceOf(UploadNotSentError);
  });

  for (const status of [401, 403]) {
    it(`HTTP ${status}: terminal CH_NOT_WIRED (not the retryable outage code), one portal call, one alert`, async () => {
      const uploads: string[] = [];
      const transport = new DirectMacTransport({
        attempts: new InMemoryAttemptStore(),
        gateway: buildDirectMacGateway({
          x12,
          macPortal: portal(status, uploads),
          controlNumberOf: async () => null,
        }),
      });
      const { d, captured } = deps({ vendor: "direct_mac", transport });
      const errors: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        await upload(d).catch((e: Error) => errors.push(e.message));
      }
      expect(errors.every((m) => m.includes(CH.NOT_WIRED))).toBe(true);
      expect(errors.some((m) => m.includes(CH.UNAVAILABLE))).toBe(false);
      expect(uploads).toHaveLength(1);
      expect(captured.alerts).toHaveLength(1);
      expect(everything(captured, errors.join("|"))).not.toContain(MBI);
    });
  }
});
