// WP 3.2 - clinical link decision logic with in-memory fakes: every denial is the SAME refusal, a null patient is refused
// for every kind but idg_meeting, the cap and flag live in the sanitiser / route, and open states are identical.
import { type ClinicalLinkKind, type ClinicalLinkSummary, type RichBody } from "@chartwarden/types";
import { sanitizeRichBody } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CLINICAL_LINK_KINDS,
  CLINICAL_LINK_NOT_AVAILABLE,
  type ClinicalLinkSourcePorts,
  type LinkPermits,
  assertLinksMatchBody,
  deepLinkFor,
  resolveClinicalLink,
  validateClinicalLinks,
} from "./clinical-link-service";

const ORG = "org_a";
const SRC = "11111111-1111-4111-8111-111111111111";
const PAT = "22222222-2222-4222-8222-222222222222";

const bodyWith = (...links: Array<{ kind: ClinicalLinkKind; entityId: string }>): RichBody => {
  const r = sanitizeRichBody({
    schemaVersion: 1,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: links.map((l) => ({ type: "clinicalLink", ...l })) }],
    },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

const summary = (over: Partial<ClinicalLinkSummary> = {}): ClinicalLinkSummary => ({
  id: SRC,
  patientId: PAT as never,
  status: "active",
  occurredAt: "2026-10-01T10:00:00.000Z" as never,
  ...over,
});

function fakes(opts: {
  result?: ClinicalLinkSummary | null | "throw";
  allow?: boolean | "crash";
}) {
  const calls = { summary: 0, permits: 0, failures: [] as ClinicalLinkKind[] };
  const ports: ClinicalLinkSourcePorts = {
    summary: async () => {
      calls.summary += 1;
      if (opts.result === "throw") throw new Error("Jane Doe morphine 5mg");
      return opts.result === undefined ? summary() : opts.result;
    },
  };
  const permits: LinkPermits = async () => {
    calls.permits += 1;
    if (opts.allow === "crash") throw new Error("abac down");
    return opts.allow !== false;
  };
  return {
    calls,
    deps: { ports, permits, onSeamFailure: (k: ClinicalLinkKind) => calls.failures.push(k) },
  };
}

const refusal = {
  code: CLINICAL_LINK_NOT_AVAILABLE,
  message: "link not available",
  statusCode: 422,
};

describe("validateClinicalLinks", () => {
  it("returns the validated (kind, source, patient) for every kind and touches no seam for a body without links", async () => {
    for (const kind of CLINICAL_LINK_KINDS) {
      const { deps } = fakes({
        result: summary({ patientId: kind === "idg_meeting" ? null : (PAT as never) }),
      });
      const out = await validateClinicalLinks(ORG, bodyWith({ kind, entityId: SRC }), deps);
      expect(out).toEqual([
        { kind, sourceId: SRC, patientId: kind === "idg_meeting" ? null : PAT },
      ]);
    }
    const { calls, deps } = fakes({});
    expect(await validateClinicalLinks(ORG, undefined, deps)).toEqual([]);
    expect(calls.summary).toBe(0);
  });

  it.each([
    ["missing source", { result: null }],
    ["permission or scope denied", { result: summary(), allow: false }],
    ["seam failure", { result: "throw" as const }],
    ["guard crash", { result: summary(), allow: "crash" as const }],
    ["summary for another id", { result: summary({ id: PAT }) }],
    ["null patient on a patient kind", { result: summary({ patientId: null }) }],
  ])("refuses with the identical error: %s", async (_name, opts) => {
    const { deps } = fakes(opts as never);
    const err = await validateClinicalLinks(
      ORG,
      bodyWith({ kind: "order", entityId: SRC }),
      deps,
    ).catch((e) => e);
    expect(err).toMatchObject(refusal);
  });

  it("allows a null patient only for an idg_meeting", async () => {
    const { deps } = fakes({ result: summary({ patientId: null }) });
    await expect(
      validateClinicalLinks(ORG, bodyWith({ kind: "idg_meeting", entityId: SRC }), deps),
    ).resolves.toHaveLength(1);
  });

  it("logs the kind only on a seam failure, never the error text", async () => {
    const { calls, deps } = fakes({ result: "throw" });
    await validateClinicalLinks(ORG, bodyWith({ kind: "visit", entityId: SRC }), deps).catch(
      () => {},
    );
    expect(calls.failures).toEqual(["visit"]);
    expect(JSON.stringify(calls.failures)).not.toContain("Jane");
  });

  it("stops at the first refused link of several", async () => {
    const { calls, deps } = fakes({ result: null });
    await validateClinicalLinks(
      ORG,
      bodyWith({ kind: "order", entityId: SRC }, { kind: "visit", entityId: PAT }),
      deps,
    ).catch(() => {});
    expect(calls.summary).toBe(1);
  });
});

describe("assertLinksMatchBody", () => {
  const ok = [{ kind: "order" as const, sourceId: SRC, patientId: PAT }];
  it("accepts exactly the body's links, in any order, and none for a body without any", () => {
    expect(assertLinksMatchBody(bodyWith({ kind: "order", entityId: SRC }), ok)).toEqual(ok);
    expect(assertLinksMatchBody(undefined, undefined)).toEqual([]);
  });
  it("refuses an unvalidated node, a stray validated link, or a different one", () => {
    expect(() =>
      assertLinksMatchBody(bodyWith({ kind: "order", entityId: SRC }), undefined),
    ).toThrow(/link not available/);
    expect(() => assertLinksMatchBody(undefined, ok)).toThrow(/link not available/);
    expect(() => assertLinksMatchBody(bodyWith({ kind: "visit", entityId: SRC }), ok)).toThrow(
      /link not available/,
    );
  });
});

describe("resolveClinicalLink", () => {
  const now = () => new Date("2026-10-14T12:00:00.000Z");
  const link = { kind: "order" as const, sourceId: SRC };

  it("returns the live status, occurrence time, as_of and the deep link, no free text", async () => {
    const { deps } = fakes({});
    const out = await resolveClinicalLink(link, ORG, { ...deps, now });
    expect(out).toEqual({
      state: "ok",
      kind: "order",
      status: "active",
      occurred_at: "2026-10-01T10:00:00.000Z",
      as_of: "2026-10-14T12:00:00.000Z",
      link: `/orders/${SRC}`,
      patient_id: PAT,
    });
  });

  it("is the identical unavailable for missing, forbidden, erased-as-null, failing and crashing sources", async () => {
    const answers = await Promise.all(
      [
        { result: null },
        { allow: false },
        { result: "throw" as const },
        { allow: "crash" as const },
      ].map((opts) => resolveClinicalLink(link, ORG, { ...fakes(opts as never).deps, now })),
    );
    for (const a of answers) expect(a).toEqual({ state: "unavailable" });
  });

  it("reflects the source's CURRENT state, not a snapshot", async () => {
    let status = "active";
    const ports: ClinicalLinkSourcePorts = { summary: async () => summary({ status }) };
    const deps = { ports, permits: async () => true, now };
    expect(await resolveClinicalLink(link, ORG, deps)).toMatchObject({ status: "active" });
    status = "discontinued";
    expect(await resolveClinicalLink(link, ORG, deps)).toMatchObject({ status: "discontinued" });
  });

  it("builds each documented deep link", () => {
    const s = summary();
    expect(CLINICAL_LINK_KINDS.map((k) => deepLinkFor(k, s))).toEqual([
      `/medication-orders/${SRC}`,
      `/orders/${SRC}`,
      `/care-plans/${SRC}/summary`,
      `/patients/${PAT}/assessments/${SRC}`,
      `/scheduling/visits/${SRC}`,
      `/patients/${PAT}/documents`,
      `/idg/meetings/${SRC}`,
    ]);
  });
});
