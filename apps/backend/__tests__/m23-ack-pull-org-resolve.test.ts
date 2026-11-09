// The 999 / 277CA ack crons run for EVERY organization in one BullMQ job (ADR-0053 amendment 2026-11-06). Two rules, as in M25 and M41:
//   - one organization whose own clearinghouse cannot be resolved (its sealed credential is unreadable, its config read failed) is
//     REPORTED for that organization (a PHI-free log line and one alert, code only) and the tick carries on: failing the shared
//     tick would retry it into the DLQ for every tenant;
//   - a failure the job does raise names an error CODE or CLASS, never the raw message (a connection string, a row), because
//     that string lands in job data and logs.
import { ChartWardenError } from "@chartwarden/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLEARINGHOUSE_UNBOUND_ALERT,
  __resetClearinghouseAlertMemoryForTest,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-unbound-hold";
import {
  type M23WorkerDeps,
  runAckPull277ca,
  runAckPull999,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const BROKEN = "00000000-0000-4000-8000-0000000000d1"; // its sealed credential cannot be opened
const HEALTHY = "00000000-0000-4000-8000-0000000000d2";
const SECRET = "postgres://app:hunter2@10.0.0.9/chartwarden";

function deps(opts: {
  readonly resolveError?: unknown;
  readonly pullError?: unknown;
}) {
  const polled: string[] = [];
  const logs: { fields: Record<string, unknown>; message: string }[] = [];
  const alerts: { alertCode: string; organizationId: string; payload: Record<string, unknown> }[] =
    [];
  const transport = {} as never;
  const d = {
    connection: {} as never,
    db: {} as never,
    activeOrgs: {
      listActiveOrgs: async () => [BROKEN, HEALTHY].map((organizationId) => ({ organizationId })),
    },
    alerts: {
      dispatch: async (a: (typeof alerts)[number]) => {
        alerts.push(a);
      },
    },
    logger: {
      error: (fields: Record<string, unknown>, message: string) => logs.push({ fields, message }),
    },
    transport: {
      binding: {
        vendor: null,
        transport,
        forOrg: async (organizationId: string) => {
          if (organizationId === BROKEN && opts.resolveError) throw opts.resolveError;
          return { vendor: "stedi", account: "tenant", transport };
        },
      },
      contexts: {
        contextFor: async () => {
          throw new Error("no provider entity is pulled in this test");
        },
        providerEntitiesFor: async (organizationId: string) => {
          polled.push(organizationId);
          if (organizationId === HEALTHY && opts.pullError) throw opts.pullError;
          return [];
        },
      },
    },
  } as unknown as M23WorkerDeps;
  return { d, polled, logs, alerts };
}

const unreadable = () =>
  new ChartWardenError(
    "CLEARINGHOUSE_CREDENTIAL_UNREADABLE",
    "this organization's clearinghouse credential could not be opened",
    503,
  );

describe("the M23 ack pull reports an organization whose clearinghouse cannot be resolved, and carries on", () => {
  beforeEach(__resetClearinghouseAlertMemoryForTest);

  for (const [name, pull] of [
    ["999", runAckPull999],
    ["277CA", runAckPull277ca],
  ] as const) {
    it(`${name}: an unreadable credential is reported for that org and does not fail the tick`, async () => {
      const { d, polled, logs, alerts } = deps({ resolveError: unreadable() });
      await expect(pull(d)).resolves.toBeUndefined();
      expect(polled).toEqual([HEALTHY]); // the other organization was still pulled
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        alertCode: CLEARINGHOUSE_UNBOUND_ALERT,
        organizationId: BROKEN,
        payload: { reason: "CLEARINGHOUSE_CREDENTIAL_UNREADABLE" },
      });
      expect(logs.some((l) => l.fields.organizationId === BROKEN)).toBe(true);
    });

    it(`${name}: an untyped resolve failure is reported by class only, never its message`, async () => {
      const { d, polled, logs, alerts } = deps({ resolveError: new Error(SECRET) });
      await expect(pull(d)).resolves.toBeUndefined();
      expect(polled).toEqual([HEALTHY]);
      const reported = JSON.stringify({ logs, alerts });
      expect(reported).toContain("Error");
      expect(reported).not.toContain("hunter2");
    });

    it(`${name}: a failure the job raises names a class or code, never the raw message`, async () => {
      const { d } = deps({ pullError: new Error(SECRET) });
      const raised = await pull(d).catch((error: unknown) => error as Error);
      expect(raised).toBeInstanceOf(Error);
      expect((raised as Error).message).toContain(`org ${HEALTHY}: Error`);
      expect((raised as Error).message).not.toContain("hunter2");
    });
  }
});
