// packages/saas-tenant-platform/__tests__/shred-worker.test.ts — M34 §3.5 / §7.2 SAFETY invariants.
//
// The IRREVERSIBLE four-phase cryptographic shred (`runTenantShred`, src/services/shred-worker.ts) +
// the on-demand DEK rotation (`handleDekRotate`, src/services/dek-rotate-worker.ts). Both workers are
// PURE orchestration over injected ports, so they are driven here by fake ports that record call order
// (the packages/dosespot pure-machine + apps/backend mdm-eraser port-acceptance precedents).
//
// The assertions are the destruction SAFETY invariants, not feature coverage:
//   (1) each of the four phases is IDEMPOTENT — a re-run with the phase marker already present is a no-op;
//   (2) the 42 CFR Part 2 refusal gate (M34-F08) ABORTS before DEK destruction — an eraseFn returning
//       `refused_part_two_retention` re-defers the tenant to `retained`, the DEK survives, Phase 3 is
//       never reached;
//   (3) the destroy port (`destroyTenantKeyRing`) is invoked EXACTLY ONCE, and only AFTER the erasers +
//       the MinIO scope destruction;
//   (4) the M4 destruction-cert callback path is exercised (no bypass) — the eraser fan-out + the cert
//       refusal/file calls all thread the certificate id.
import type { schema } from "@chartwarden/db";
import {
  type DekRotateJob,
  DekRotateKeyRingDestroyed,
  DekRotateKeyRingMissing,
  type DekRotateWorkerPorts,
  type EraserReceipt,
  type PriorDekVersion,
  SHRED_PHASES,
  type ShredJob,
  ShredKeyRingMissing,
  type ShredWorkerPorts,
  type WrappedDek,
  handleDekRotate,
  runTenantShred,
} from "@chartwarden/saas-tenant-platform";
import { describe, expect, it } from "vitest";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const ORG = "org_1";
const TENANT = "tenant_1";
const CERT = "cert_1";
const ACTOR = "membership_ops_1";
const RING_ID = "kr_1";
const FIXED_NOW = new Date("2026-06-25T12:00:00.000Z");

const JOB: ShredJob = {
  tenantAccountId: TENANT,
  orgId: ORG,
  destructionCertId: CERT,
  actorMembershipId: ACTOR,
  transitionReason: "tenant offboarding complete",
};

/** Every eraseFn returned a non-refusal `erased` receipt — the DEK-destruction path is permitted. */
const ERASED_RECEIPTS: readonly EraserReceipt[] = [
  { module: "m05", outcome: "erased", erasedRows: 42, sha256: "sha-m05" },
  { module: "saas_tenant_platform_class", outcome: "erased", erasedRows: 3, sha256: "sha-m34" },
];

/** One module refused on a 42 CFR Part 2 retention obligation (M4 D8) — the gate must abort. */
const REFUSAL_RECEIPTS: readonly EraserReceipt[] = [
  { module: "m05", outcome: "erased", erasedRows: 42, sha256: "sha-m05" },
  { module: "m04", outcome: "refused_part_two_retention", refusedRows: 7 },
];

function makeRing(overrides: Partial<schema.TenantKeyRing> = {}): schema.TenantKeyRing {
  return {
    id: RING_ID,
    organizationId: ORG,
    tenantAccountId: TENANT,
    currentDekVersion: "v1",
    currentDekKekWrappedCiphertext: Buffer.from("wrapped-dek-ciphertext"),
    currentDekKekId: "kek_1",
    priorDekVersions: [],
    dekCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    dekLastRotatedAt: null,
    destroyedAt: null,
    destroyedByMembershipId: null,
    destructionCertificateId: null,
    ...overrides,
  } as schema.TenantKeyRing;
}

interface SeedLogRow {
  readonly destructionPhase: string;
  readonly perModuleEraserReceipts?: unknown;
  readonly destructionCertificateId?: string;
}

/** Build the shred ports over an in-memory key-ring repo + recording fakes; returns the recorded call
 *  trail so order/exactly-once assertions are deterministic. */
function makeShredPorts(
  opts: {
    ring?: schema.TenantKeyRing | null;
    receipts?: readonly EraserReceipt[];
    seedLog?: readonly SeedLogRow[];
  } = {},
) {
  const calls: string[] = [];
  const ring = opts.ring === undefined ? makeRing() : opts.ring;
  const receipts = opts.receipts ?? ERASED_RECEIPTS;

  // The append-only destruction-phase trail; seeded markers simulate a crash/replay resume.
  const log: {
    destructionPhase: string;
    destructionCertificateId: string;
    perModuleEraserReceipts: unknown;
    occurredAt: Date;
  }[] = (opts.seedLog ?? []).map((r, i) => ({
    destructionPhase: r.destructionPhase,
    destructionCertificateId: r.destructionCertificateId ?? CERT,
    perModuleEraserReceipts: r.perModuleEraserReceipts ?? [],
    occurredAt: new Date(FIXED_NOW.getTime() - (opts.seedLog!.length - i) * 1000),
  }));

  const ports: ShredWorkerPorts = {
    now: () => FIXED_NOW,
    keyRing: {
      findByTenantAccountId: async () => {
        calls.push("keyRing.findByTenantAccountId");
        return ring;
      },
      listDestructionLog: async (_ringId, destructionCertificateId) => {
        calls.push("keyRing.listDestructionLog");
        // The real repo returns newest-first; the worker only builds a Set, so order is immaterial.
        return log
          .filter((row) => row.destructionCertificateId === destructionCertificateId)
          .reverse() as unknown as readonly schema.TenantKeyDestructionLog[];
      },
      appendDestructionLog: async (values) => {
        calls.push(`keyRing.appendDestructionLog:${values.destructionPhase}`);
        const row = {
          destructionPhase: values.destructionPhase as string,
          destructionCertificateId: values.destructionCertificateId,
          perModuleEraserReceipts: values.perModuleEraserReceipts,
          occurredAt: FIXED_NOW,
        };
        log.push(row);
        return row as unknown as schema.TenantKeyDestructionLog;
      },
    },
    erasers: {
      callbackAllEraserFns: async (input) => {
        calls.push(`erasers.callbackAllEraserFns:${input.destructionCertId}`);
        return receipts;
      },
      recordCertificateRefusal: async (input) => {
        calls.push(`erasers.recordCertificateRefusal:${input.reason}`);
      },
      fileCertificate: async (input) => {
        calls.push(`erasers.fileCertificate:${input.destructionCertId}`);
      },
    },
    destructive: {
      destroyTenantStorageScope: async () => {
        calls.push("destructive.destroyTenantStorageScope");
        return { prefix: `tenants/${ORG}/`, objectsDeleted: 7 };
      },
      destroyTenantKeyRing: async () => {
        calls.push("destructive.destroyTenantKeyRing");
        // Mirror the SECURITY DEFINER fn: the ring becomes the cryptographic-shred terminal state.
        if (ring) {
          ring.destroyedAt = FIXED_NOW;
          ring.currentDekKekWrappedCiphertext = null;
          ring.priorDekVersions = [];
        }
      },
    },
    audit: {
      recordDestructionCertified: async () => {
        calls.push("audit.recordDestructionCertified");
      },
      recordDestructionDeferred: async () => {
        calls.push("audit.recordDestructionDeferred");
      },
    },
    lifecycle: {
      commitDestroyed: async () => {
        calls.push("lifecycle.commitDestroyed");
      },
      commitDeferToRetained: async () => {
        calls.push("lifecycle.commitDeferToRetained");
      },
    },
    assertCertApprovedAndNoHold: async () => {
      calls.push("assertCertApprovedAndNoHold");
    },
  };

  return { ports, calls, log, ring };
}

/** Count how many times a recorded call appears (the exactly-once oracle). */
const count = (calls: readonly string[], name: string) => calls.filter((c) => c === name).length;

describe("M34 §3.5 cryptographic shred — happy path (four phases, destroyed)", () => {
  it("runs all four phases in the §3.5 order and reports `destroyed`", async () => {
    const { ports, calls } = makeShredPorts();
    const result = await runTenantShred(JOB, ports);

    expect(result.outcome).toBe("destroyed");
    expect(result.tenantAccountId).toBe(TENANT);
    expect(result.orgId).toBe(ORG);
    expect(result.eraserReceipts).toEqual(ERASED_RECEIPTS);
    expect(result.refusedRowsByModule).toEqual([]);
    // The four phase markers were newly written, in §3.5 execution order.
    expect(result.phasesRun).toEqual([
      SHRED_PHASES.erasersComplete,
      SHRED_PHASES.minioDestroyed,
      SHRED_PHASES.deksZeroized,
      SHRED_PHASES.certificateFiled,
    ]);

    // Preflight runs before the eraser fan-out; the deferral branch is never taken.
    expect(calls).toContain("assertCertApprovedAndNoHold");
    expect(calls).not.toContain("lifecycle.commitDeferToRetained");
    expect(calls).not.toContain("audit.recordDestructionDeferred");
    expect(calls).not.toContain("erasers.recordCertificateRefusal");
    expect(calls).toContain("lifecycle.commitDestroyed");
    expect(calls).toContain("audit.recordDestructionCertified");
  });

  it("orders the irreversible DEK destroy strictly AFTER erasers + MinIO, and before cert-file/commit", async () => {
    const { ports, calls } = makeShredPorts();
    await runTenantShred(JOB, ports);

    const idx = (n: string) => calls.indexOf(n);
    const eraseAt = idx(`erasers.callbackAllEraserFns:${CERT}`);
    const minioAt = idx("destructive.destroyTenantStorageScope");
    const destroyAt = idx("destructive.destroyTenantKeyRing");
    const fileAt = idx(`erasers.fileCertificate:${CERT}`);
    const commitAt = idx("lifecycle.commitDestroyed");

    expect(eraseAt).toBeGreaterThanOrEqual(0);
    expect(minioAt).toBeGreaterThan(eraseAt);
    expect(destroyAt).toBeGreaterThan(minioAt); // Phase 3 only after Phase 1 + Phase 2
    expect(fileAt).toBeGreaterThan(destroyAt); // Phase 4 file/commit only after the irreversible event
    expect(commitAt).toBeGreaterThan(destroyAt);
  });

  it("invokes the destroy port EXACTLY ONCE (invariant 3)", async () => {
    const { ports, calls } = makeShredPorts();
    await runTenantShred(JOB, ports);
    expect(count(calls, "destructive.destroyTenantKeyRing")).toBe(1);
  });
});

describe("M34 §7.2 step 7 — per-phase IDEMPOTENCY (invariant 1)", () => {
  it("a full re-run against the same trail is a complete no-op (no phase re-executes)", async () => {
    const harness = makeShredPorts();
    const first = await runTenantShred(JOB, harness.ports);
    expect(first.phasesRun).toHaveLength(4);

    // Second delivery: the trail now carries every marker.
    harness.calls.length = 0;
    const second = await runTenantShred(JOB, harness.ports);
    expect(second.outcome).toBe("destroyed");
    expect(second.phasesRun).toEqual([]); // nothing newly written
    expect(harness.calls).not.toContain(`erasers.callbackAllEraserFns:${CERT}`);
    expect(harness.calls).not.toContain("destructive.destroyTenantStorageScope");
    expect(harness.calls).not.toContain("destructive.destroyTenantKeyRing");
    expect(harness.calls).not.toContain(`erasers.fileCertificate:${CERT}`);
    // Across BOTH deliveries the irreversible destroy fired exactly once (invariant 3).
    expect(count(harness.calls, "destructive.destroyTenantKeyRing")).toBe(0);
  });

  it("does not re-run approval preflight after the certificate is already filed", async () => {
    const { ports, calls } = makeShredPorts({
      seedLog: [
        {
          destructionPhase: SHRED_PHASES.erasersComplete,
          perModuleEraserReceipts: ERASED_RECEIPTS,
        },
        { destructionPhase: SHRED_PHASES.minioDestroyed },
        { destructionPhase: SHRED_PHASES.deksZeroized },
        { destructionPhase: SHRED_PHASES.certificateFiled },
      ],
    });
    ports.assertCertApprovedAndNoHold = async () => {
      calls.push("preflight");
      throw new Error("an executed certificate is no longer approved");
    };
    await expect(runTenantShred(JOB, ports)).resolves.toMatchObject({ outcome: "destroyed" });
    expect(calls).not.toContain("preflight");
  });

  it("Phase 1 marker present ⇒ the eraser fan-out is NOT re-fired (receipts recovered from the log)", async () => {
    const { ports, calls } = makeShredPorts({
      seedLog: [
        {
          destructionPhase: SHRED_PHASES.erasersComplete,
          perModuleEraserReceipts: ERASED_RECEIPTS,
        },
      ],
    });
    const result = await runTenantShred(JOB, ports);
    expect(calls).not.toContain(`erasers.callbackAllEraserFns:${CERT}`);
    expect(result.eraserReceipts).toEqual(ERASED_RECEIPTS); // recovered, not re-fired
    expect(result.outcome).toBe("destroyed");
    expect(result.phasesRun).toEqual([
      SHRED_PHASES.minioDestroyed,
      SHRED_PHASES.deksZeroized,
      SHRED_PHASES.certificateFiled,
    ]);
  });

  it("Phase 2 marker present ⇒ the MinIO scope destroy is NOT re-run", async () => {
    const { ports, calls } = makeShredPorts({
      seedLog: [
        {
          destructionPhase: SHRED_PHASES.erasersComplete,
          perModuleEraserReceipts: ERASED_RECEIPTS,
        },
        { destructionPhase: SHRED_PHASES.minioDestroyed },
      ],
    });
    const result = await runTenantShred(JOB, ports);
    expect(calls).not.toContain("destructive.destroyTenantStorageScope");
    expect(result.phasesRun).toEqual([SHRED_PHASES.deksZeroized, SHRED_PHASES.certificateFiled]);
  });

  it("Phase 3 marker present ⇒ the DEK destroy is NEVER re-invoked (one-way, never resurrects a key)", async () => {
    const { ports, calls } = makeShredPorts({
      seedLog: [
        {
          destructionPhase: SHRED_PHASES.erasersComplete,
          perModuleEraserReceipts: ERASED_RECEIPTS,
        },
        { destructionPhase: SHRED_PHASES.minioDestroyed },
        { destructionPhase: SHRED_PHASES.deksZeroized },
      ],
    });
    const result = await runTenantShred(JOB, ports);
    expect(calls).not.toContain("destructive.destroyTenantKeyRing");
    expect(count(calls, "destructive.destroyTenantKeyRing")).toBe(0);
    // Only Phase 4 remains — the resume just files the certificate + flips the status.
    expect(result.phasesRun).toEqual([SHRED_PHASES.certificateFiled]);
    expect(result.outcome).toBe("destroyed");
  });

  it("Phase 4 marker present ⇒ the whole shred is a no-op (every marker already filed)", async () => {
    const { ports, calls } = makeShredPorts({
      seedLog: [
        {
          destructionPhase: SHRED_PHASES.erasersComplete,
          perModuleEraserReceipts: ERASED_RECEIPTS,
        },
        { destructionPhase: SHRED_PHASES.minioDestroyed },
        { destructionPhase: SHRED_PHASES.deksZeroized },
        { destructionPhase: SHRED_PHASES.certificateFiled },
      ],
    });
    const result = await runTenantShred(JOB, ports);
    expect(result.phasesRun).toEqual([]);
    expect(result.outcome).toBe("destroyed");
    expect(calls).not.toContain(`erasers.fileCertificate:${CERT}`);
    expect(calls).not.toContain("lifecycle.commitDestroyed");
  });
});

describe("M34-F08 — the 42 CFR Part 2 refusal gate aborts before DEK destruction (invariant 2)", () => {
  it("a `refused_part_two_retention` eraseFn re-defers to `retained` and the DEK SURVIVES", async () => {
    const { ports, calls, ring } = makeShredPorts({ receipts: REFUSAL_RECEIPTS });
    const result = await runTenantShred(JOB, ports);

    expect(result.outcome).toBe("deferred_part_two_retention");
    expect(result.refusedRowsByModule).toEqual([{ module: "m04", refusedRows: 7 }]);

    // THE DEK SURVIVES — neither MinIO nor the destroy port is ever reached.
    expect(calls).not.toContain("destructive.destroyTenantStorageScope");
    expect(calls).not.toContain("destructive.destroyTenantKeyRing");
    expect(count(calls, "destructive.destroyTenantKeyRing")).toBe(0);
    expect(ring?.currentDekKekWrappedCiphertext).not.toBeNull(); // ciphertext intact
    expect(ring?.destroyedAt).toBeNull();

    // Phase 3/4 markers are never written; only Phase 1 + the abort marker.
    expect(result.phasesRun).toEqual([SHRED_PHASES.erasersComplete, SHRED_PHASES.refusalAborted]);
    expect(result.phasesRun).not.toContain(SHRED_PHASES.deksZeroized);
  });

  it("records the refusal on the M4 cert, re-defers, and writes the critical deferral audit — not the certified one", async () => {
    const { ports, calls } = makeShredPorts({ receipts: REFUSAL_RECEIPTS });
    await runTenantShred(JOB, ports);

    expect(calls).toContain("erasers.recordCertificateRefusal:part_two_retention");
    expect(calls).toContain("lifecycle.commitDeferToRetained");
    expect(calls).toContain("audit.recordDestructionDeferred");
    // The success-path effects must NOT fire on a refusal.
    expect(calls).not.toContain("lifecycle.commitDestroyed");
    expect(calls).not.toContain("audit.recordDestructionCertified");
    expect(calls).not.toContain(`erasers.fileCertificate:${CERT}`);
  });

  it("aborts when only SOME modules refuse, surfacing only the refused modules' counts", async () => {
    const mixed: readonly EraserReceipt[] = [
      { module: "m05", outcome: "erased", erasedRows: 10 },
      { module: "m04", outcome: "refused_part_two_retention", refusedRows: 4 },
      { module: "m22", outcome: "refused_part_two_retention", refusedRows: 2 },
    ];
    const { ports, calls } = makeShredPorts({ receipts: mixed });
    const result = await runTenantShred(JOB, ports);

    expect(result.outcome).toBe("deferred_part_two_retention");
    expect(result.refusedRowsByModule).toEqual([
      { module: "m04", refusedRows: 4 },
      { module: "m22", refusedRows: 2 },
    ]);
    expect(calls).not.toContain("destructive.destroyTenantKeyRing");
  });

  it("a replay AFTER a refusal abort re-defers idempotently and never reaches DEK destruction", async () => {
    const { ports, calls } = makeShredPorts({
      receipts: REFUSAL_RECEIPTS,
      seedLog: [
        {
          destructionPhase: SHRED_PHASES.erasersComplete,
          perModuleEraserReceipts: REFUSAL_RECEIPTS,
        },
        {
          destructionPhase: SHRED_PHASES.refusalAborted,
          perModuleEraserReceipts: [{ module: "m04", refusedRows: 7 }],
        },
      ],
    });
    const result = await runTenantShred(JOB, ports);

    expect(result.outcome).toBe("deferred_part_two_retention");
    expect(result.refusedRowsByModule).toEqual([{ module: "m04", refusedRows: 7 }]);
    expect(result.eraserReceipts).toEqual(REFUSAL_RECEIPTS); // recovered from the trail
    expect(result.phasesRun).toEqual([]); // nothing re-written on the terminal deferred state
    // The replay never re-records the refusal, re-defers, or touches the DEK.
    expect(calls).not.toContain("erasers.recordCertificateRefusal:part_two_retention");
    expect(calls).not.toContain("lifecycle.commitDeferToRetained");
    expect(calls).not.toContain("destructive.destroyTenantKeyRing");
  });

  it("a later certificate gets a fresh phase trail after the Part 2 obligation lapses", async () => {
    const harness = makeShredPorts({ receipts: REFUSAL_RECEIPTS });
    await expect(runTenantShred(JOB, harness.ports)).resolves.toMatchObject({
      outcome: "deferred_part_two_retention",
    });
    harness.ports.erasers.callbackAllEraserFns = async () => ERASED_RECEIPTS;
    const laterJob = { ...JOB, destructionCertId: "cert_2" };
    await expect(runTenantShred(laterJob, harness.ports)).resolves.toMatchObject({
      outcome: "destroyed",
    });
    expect(count(harness.calls, "destructive.destroyTenantKeyRing")).toBe(1);
  });
});

describe("M34 §3.5 — the M4 destruction-cert callback path is exercised, no bypass (invariant 4)", () => {
  it("threads the certificate id through the eraser fan-out + the file-certificate call (success path)", async () => {
    const { ports, calls } = makeShredPorts();
    await runTenantShred(JOB, ports);
    // Phase 1 fires the M4 registry; Phase 4 finalizes the M4 certificate — both keyed on CERT.
    expect(calls).toContain(`erasers.callbackAllEraserFns:${CERT}`);
    expect(calls).toContain(`erasers.fileCertificate:${CERT}`);
  });

  it("records the M4 certificate refusal (no bypass) on the abort path", async () => {
    const { ports, calls } = makeShredPorts({ receipts: REFUSAL_RECEIPTS });
    await runTenantShred(JOB, ports);
    expect(calls).toContain("erasers.recordCertificateRefusal:part_two_retention");
  });
});

describe("M34 §3.5 — hard upstream guards", () => {
  it("throws ShredKeyRingMissing when the tenant was never provisioned", async () => {
    const { ports } = makeShredPorts({ ring: null });
    await expect(runTenantShred(JOB, ports)).rejects.toBeInstanceOf(ShredKeyRingMissing);
  });

  it("refuses a blank transition reason (§2.4.1)", async () => {
    const { ports } = makeShredPorts();
    await expect(runTenantShred({ ...JOB, transitionReason: "   " }, ports)).rejects.toThrow(
      /non-empty transition reason/,
    );
  });
});

// ── DEK rotation (Pillar 3) — NOT the destruction path; never nulls ciphertext ──────────────────────
function makeRotatePorts(opts: { ring?: schema.TenantKeyRing | null } = {}) {
  const calls: string[] = [];
  const ring = opts.ring === undefined ? makeRing() : opts.ring;
  let recorded: { id: string; patch: Record<string, unknown> } | null = null;

  const minted: WrappedDek = {
    kekWrappedCiphertext: Buffer.from("new-wrapped-dek"),
    kekId: "kek_2",
  };

  const ports: DekRotateWorkerPorts = {
    now: () => FIXED_NOW,
    keyRing: {
      findByOrganizationId: async () => {
        calls.push("keyRing.findByOrganizationId");
        return ring;
      },
      recordRotation: async (id, patch) => {
        calls.push("keyRing.recordRotation");
        recorded = { id, patch: patch as Record<string, unknown> };
        return { ...(ring as schema.TenantKeyRing), ...patch } as schema.TenantKeyRing;
      },
    },
    keyMaterial: {
      mintAndWrapDek: async () => {
        calls.push("keyMaterial.mintAndWrapDek");
        return minted;
      },
    },
    outbox: {
      emitDekRotationCompleted: async () => {
        calls.push("outbox.emitDekRotationCompleted");
      },
    },
    audit: {
      recordDekRotated: async () => {
        calls.push("audit.recordDekRotated");
      },
    },
  };

  return { ports, calls, getRecorded: () => recorded };
}

const ROTATE_JOB: DekRotateJob = { orgId: ORG, actorMembershipId: ACTOR };

describe("M34 §3.5 — DEK rotation (handleDekRotate)", () => {
  it("rotates v1 → v2: mints, appends the outgoing prior, records, audits, and emits", async () => {
    const { ports, calls, getRecorded } = makeRotatePorts();
    const result = await handleDekRotate(ROTATE_JOB, ports);

    expect(result).toEqual({ outcome: "rotated", orgId: ORG, fromVersion: "v1", toVersion: "v2" });
    // Mint happens BEFORE the commit (the ring is never left without a current ciphertext).
    expect(calls.indexOf("keyMaterial.mintAndWrapDek")).toBeLessThan(
      calls.indexOf("keyRing.recordRotation"),
    );
    expect(calls).toContain("audit.recordDekRotated");
    expect(calls).toContain("outbox.emitDekRotationCompleted");

    const recorded = getRecorded();
    expect(recorded?.patch.currentDekVersion).toBe("v2");
    expect(recorded?.patch.currentDekKekId).toBe("kek_2");
    // The outgoing v1 is appended as a decrypt-only prior version (base64 of the old ciphertext).
    const priors = recorded?.patch.priorDekVersions as readonly PriorDekVersion[];
    expect(priors).toHaveLength(1);
    expect(priors[0]?.version).toBe("v1");
    expect(priors[0]?.kekWrappedCiphertext).toBe(
      Buffer.from("wrapped-dek-ciphertext").toString("base64"),
    );
  });

  it("is idempotent on the target version — a redelivery at the current version mints no second DEK", async () => {
    const { ports, calls } = makeRotatePorts({ ring: makeRing({ currentDekVersion: "v3" }) });
    const result = await handleDekRotate({ ...ROTATE_JOB, targetVersion: "v3" }, ports);
    expect(result.outcome).toBe("already_rotated");
    expect(calls).not.toContain("keyMaterial.mintAndWrapDek");
    expect(calls).not.toContain("keyRing.recordRotation");
  });

  it("refuses to rotate a destroyed (cryptographically shredded) ring — never resurrects a key", async () => {
    const destroyed = makeRing({
      destroyedAt: FIXED_NOW,
      currentDekKekWrappedCiphertext: null,
    });
    const { ports } = makeRotatePorts({ ring: destroyed });
    await expect(handleDekRotate(ROTATE_JOB, ports)).rejects.toBeInstanceOf(
      DekRotateKeyRingDestroyed,
    );
  });

  it("throws DekRotateKeyRingMissing when the org was never provisioned", async () => {
    const { ports } = makeRotatePorts({ ring: null });
    await expect(handleDekRotate(ROTATE_JOB, ports)).rejects.toBeInstanceOf(
      DekRotateKeyRingMissing,
    );
  });

  it("rejects a stale/out-of-order target version (monotonic invariant)", async () => {
    const { ports } = makeRotatePorts({ ring: makeRing({ currentDekVersion: "v5" }) });
    await expect(handleDekRotate({ ...ROTATE_JOB, targetVersion: "v2" }, ports)).rejects.toThrow(
      /not newer than current/,
    );
  });
});
