// apps/backend/src/modules/23-billing-medicare/__tests__/_billing-repo-fakes.ts — in-memory doubles for
// the `@wardenx/billing` `repositories` namespace, shared by the M23 SERVICE tests (assembly / validation /
// override). Each service constructs its repos internally as `new repositories.X(tx)`, so the tests swap the
// real Drizzle-backed classes for these stores via a `vi.mock("@wardenx/billing")` PARTIAL override that
// keeps all pure domain (the HIPPS/SIA calculators, the rule registry, control-number, reducers, money)
// REAL and replaces only the data ports. NO DB, no Fastify, no BullMQ — plain Maps/arrays.
//
// This is NOT a test file (it ends in `.ts`, not `.test.ts`, so vitest's `*.test.ts` glob never collects it).
// It is intentionally typed loosely (`any` rows) — the goal is behavioral fidelity of the repo CONTRACT the
// services depend on (idempotent appends, version-checked transitions, point reads), not schema typing.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The shared in-memory store every fake repo reads/writes. Reset between tests via {@link FakeStore.reset}. */
export interface FakeStore {
  readonly claims: Map<string, any>;
  readonly lines: any[];
  readonly perDiemClass: any[];
  readonly sia: any[];
  readonly runs: Map<string, any>;
  readonly results: Map<string, any>;
  readonly overrides: Map<string, any>;
  readonly history: any[];
  readonly emitted: any[];
  /** Resolved HETS eligibility checks (newest last) the RHC carry-over reads. */
  readonly eligibilityChecks: any[];
  reset(): void;
}

/** Build the fake `repositories` class bundle + its shared {@link FakeStore}. */
export function buildFakeRepositories(): {
  readonly store: FakeStore;
  readonly repos: Record<string, unknown>;
} {
  let seq = 0;
  const newId = (prefix: string): string => `${prefix}-${String(++seq).padStart(4, "0")}`;

  const store: FakeStore = {
    claims: new Map<string, any>(),
    lines: [],
    perDiemClass: [],
    sia: [],
    runs: new Map<string, any>(),
    results: new Map<string, any>(),
    overrides: new Map<string, any>(),
    history: [],
    emitted: [],
    eligibilityChecks: [],
    reset(): void {
      this.claims.clear();
      this.lines.length = 0;
      this.perDiemClass.length = 0;
      this.sia.length = 0;
      this.runs.clear();
      this.results.clear();
      this.overrides.clear();
      this.history.length = 0;
      this.emitted.length = 0;
      this.eligibilityChecks.length = 0;
      seq = 0;
    },
  };

  class ClaimRepository {
    async create(input: any): Promise<any> {
      const row = {
        version: 0,
        state: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
        replacesClaimId: null,
        ...input,
      };
      store.claims.set(row.id, row);
      return row;
    }
    async findById(id: string): Promise<any> {
      return store.claims.get(id) ?? null;
    }
    async listByOrgPage(
      organizationId: string,
      filter: any,
      _cursor: unknown,
      _limit: unknown,
    ): Promise<{ items: any[]; nextCursor: string | null; hasMore: boolean }> {
      const items = [...store.claims.values()].filter(
        (c) =>
          c.organizationId === organizationId &&
          (!filter?.providerEntityId || c.providerEntityId === filter.providerEntityId) &&
          (!filter?.patientId || c.patientId === filter.patientId) &&
          (!filter?.state || c.state === filter.state),
      );
      return { items, nextCursor: null, hasMore: false };
    }
    async transitionToState(
      id: string,
      expectedVersion: number,
      nextState: string,
      patch: any,
    ): Promise<{ ok: boolean; row?: any; currentVersion: number | null }> {
      const c = store.claims.get(id);
      if (!c) return { ok: false, currentVersion: null };
      if (c.version !== expectedVersion) return { ok: false, currentVersion: c.version };
      const row = {
        ...c,
        ...(patch ?? {}),
        state: nextState,
        version: c.version + 1,
        updatedAt: new Date(),
      };
      store.claims.set(id, row);
      return { ok: true, row, currentVersion: row.version };
    }
    /** Mirrors the real repo: refresh the derived discharge codes without bumping `version`. */
    async refreshDischargeCodes(
      id: string,
      codes: { patientStatusCode: string | null; conditionCodes: string[]; occurrenceCodes: any[] },
    ): Promise<boolean> {
      const c = store.claims.get(id);
      if (!c) return false;
      store.claims.set(id, { ...c, ...codes, updatedAt: new Date() });
      return true;
    }
    /** Mirrors the real repo: refresh the derived occurrence spans (late-NOE OSC 77) without bumping `version`. */
    async refreshOccurrenceSpans(id: string, spans: readonly any[]): Promise<boolean> {
      const c = store.claims.get(id);
      if (!c) return false;
      store.claims.set(id, { ...c, occurrenceSpans: [...spans], updatedAt: new Date() });
      return true;
    }
    /** Mirrors the real repo: refresh the derived physician NPIs (migration 1054) without bumping `version`. */
    async refreshPhysicianNpis(
      id: string,
      npis: { attendingPhysicianNpi: string | null; certifyingPhysicianNpi: string | null },
    ): Promise<boolean> {
      const c = store.claims.get(id);
      if (!c) return false;
      store.claims.set(id, { ...c, ...npis, updatedAt: new Date() });
      return true;
    }
    /** Mirrors the real repo: refresh the wage-index value codes (migration 1059) without bumping `version`. */
    async refreshValueCodes(
      id: string,
      valueCodes: readonly { code: string; cbsaCode: string }[],
    ): Promise<boolean> {
      const c = store.claims.get(id);
      if (!c) return false;
      store.claims.set(id, { ...c, valueCodes, updatedAt: new Date() });
      return true;
    }
    /** Mirrors the real repo: refresh the admission type + point of origin (migration 1057) without bumping `version`. */
    async refreshAdmissionCodes(
      id: string,
      codes: { admissionTypeCode: string | null; admissionSourceCode: string | null },
    ): Promise<boolean> {
      const c = store.claims.get(id);
      if (!c) return false;
      store.claims.set(id, { ...c, ...codes, updatedAt: new Date() });
      return true;
    }
    /** Mirrors the real repo: re-type a claim guarded on its stored TOB, without bumping `version`. */
    async refreshTypeOfBill(id: string, fromTob: string, toTob: string): Promise<boolean> {
      const c = store.claims.get(id);
      if (!c || c.tob !== fromTob) return false;
      store.claims.set(id, { ...c, tob: toTob, updatedAt: new Date() });
      return true;
    }
  }

  class ClaimLineRepository {
    async insertBatch(rows: readonly any[]): Promise<any[]> {
      return rows.map((r) => {
        const row = { id: newId("line"), ...r };
        store.lines.push(row);
        return row;
      });
    }
  }

  class PerDiemRateCalculationRepository {
    async append(v: any): Promise<any> {
      const row = { id: newId("perDiemClass"), ...v };
      store.perDiemClass.push(row);
      return row;
    }
  }

  class SiaCalculationRepository {
    async append(v: any): Promise<any> {
      const row = { id: newId("sia"), ...v };
      store.sia.push(row);
      return row;
    }
  }

  class ClaimStateHistoryRepository {
    async append(v: any): Promise<any> {
      const row = { id: newId("hist"), ...v };
      store.history.push(row);
      return row;
    }
  }

  class ValidationRunRepository {
    async append(v: any): Promise<any> {
      // Idempotent on (claimId, trigger, runInputHash) — mirrors the real onConflictDoNothing append.
      const existing = [...store.runs.values()].find(
        (r) =>
          r.claimId === v.claimId && r.trigger === v.trigger && r.runInputHash === v.runInputHash,
      );
      if (existing) return existing;
      const row = { id: v.id ?? newId("run"), ...v };
      store.runs.set(row.id, row);
      return row;
    }
    async findById(id: string): Promise<any> {
      return store.runs.get(id) ?? null;
    }
    async findByIdempotency(claimId: string, trigger: string, runInputHash: string): Promise<any> {
      return (
        [...store.runs.values()].find(
          (r) => r.claimId === claimId && r.trigger === trigger && r.runInputHash === runInputHash,
        ) ?? null
      );
    }
    async findLatestForClaim(claimId: string): Promise<any> {
      const rs = [...store.runs.values()].filter((r) => r.claimId === claimId);
      return rs.length > 0 ? rs[rs.length - 1] : null;
    }
    async listForClaim(claimId: string): Promise<any[]> {
      return [...store.runs.values()].filter((r) => r.claimId === claimId);
    }
  }

  class ValidationResultRepository {
    async appendBatch(values: readonly any[]): Promise<any[]> {
      return values.map((v) => {
        const row = { id: newId("res"), recordedAt: new Date(), ...v };
        store.results.set(row.id, row);
        return row;
      });
    }
    async append(v: any): Promise<any> {
      const row = { id: newId("res"), recordedAt: new Date(), ...v };
      store.results.set(row.id, row);
      return row;
    }
    async findById(id: string): Promise<any> {
      return store.results.get(id) ?? null;
    }
    async listFailuresForRun(validationRunId: string): Promise<any[]> {
      return [...store.results.values()].filter(
        (r) => r.validationRunId === validationRunId && r.outcome === "fail",
      );
    }
    async listForRun(validationRunId: string): Promise<any[]> {
      return [...store.results.values()].filter((r) => r.validationRunId === validationRunId);
    }
  }

  class ValidationOverrideRepository {
    async append(v: any): Promise<any> {
      // Idempotent on resultId — mirrors the real onConflictDoNothing(target=result_id) append.
      const existing = [...store.overrides.values()].find((o) => o.resultId === v.resultId);
      if (existing) return existing;
      const row = { id: newId("ovr"), appliedAt: new Date(), ...v };
      store.overrides.set(row.id, row);
      return row;
    }
    async findById(id: string): Promise<any> {
      return store.overrides.get(id) ?? null;
    }
    async findByResult(resultId: string): Promise<any> {
      return [...store.overrides.values()].find((o) => o.resultId === resultId) ?? null;
    }
    async listByResultIds(resultIds: readonly string[]): Promise<any[]> {
      return [...store.overrides.values()].filter((o) => resultIds.includes(o.resultId));
    }
  }

  class EligibilityCheckRepository {
    async findLatestResolvedForPatient(orgId: string, patientId: string): Promise<any> {
      return (
        [...store.eligibilityChecks]
          .reverse()
          .find((c) => c.organizationId === orgId && c.patientId === patientId) ?? null
      );
    }
  }

  const repos: Record<string, unknown> = {
    ClaimRepository,
    EligibilityCheckRepository,
    ClaimLineRepository,
    PerDiemRateCalculationRepository,
    SiaCalculationRepository,
    ClaimStateHistoryRepository,
    ValidationRunRepository,
    ValidationResultRepository,
    ValidationOverrideRepository,
  };

  return { store, repos };
}

/**
 * A fake `db` whose `withOrgContext` path resolves to a no-op transaction handle. `withOrgContext` calls
 * `db.transaction(cb)` then `cb(tx)` after `tx.execute(set_config…)`; the fake repos ignore `tx` entirely.
 */
export function makeFakeDb(): unknown {
  const tx = { execute: async (): Promise<unknown> => undefined };
  return { transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
}
