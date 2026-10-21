/**
 * GAP-087 — M30 CAHPS-Hospice pipeline: monthly sample selection + sealed insert, and the vendor export
 * build/storage. No database: the Drizzle surface is a small recording fake (the pipeline's SQL is plain
 * select/insert/update chains inside `withOrgContext`), the cipher is the real AES-GCM envelope over throwaway
 * keys, and the vendor adapter is the real `manual` one from `@chartwarden/cahps-vendors`.
 */
import { randomBytes } from "node:crypto";
import { CAHPS_ADAPTER_FACTORIES } from "@chartwarden/cahps-vendors";
import type { DbClient } from "@chartwarden/db";
import { type CahpsExportJob, cahpsExportProcessor, runCahpsMonthlySample } from "@chartwarden/quality";
import { describe, expect, it, vi } from "vitest";
import { createCahpsPhiCipher, keyVersionInt } from "../src/modules/30-quality/cahps/phi-cipher";
import {
  CAHPS_PENDING_CONFIGURATION,
  type CahpsDeathFacts,
  type CahpsPipelineDeps,
  buildCahpsPipelinePorts,
  isSupportedLanguage,
  periodToHalfOpen,
  uuidFromKey,
} from "../src/modules/30-quality/cahps/pipeline";
import { fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const BINDING = "33333333-3333-4333-8333-333333333333";
const EXPORT_ID = "44444444-4444-4444-8444-444444444444";

function keys() {
  const ring = new Map<string, Buffer>([["v1", randomBytes(32)]]);
  return {
    dekForOrg: async () => ({ version: "v1", key: ring.get("v1") as Buffer }),
    dekForOrgVersion: async (_org: string, version: string) => {
      const key = ring.get(version);
      if (!key) throw new Error("unknown DEK version");
      return { version, key };
    },
  };
}

const DEATH_OK: CahpsDeathFacts = {
  patientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  admissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  providerEntityId: PE,
  admissionStartAt: new Date("2026-08-01T00:00:00.000Z"),
  deathAt: new Date("2026-09-10T12:00:00.000Z"),
  source: "internal_clinician_recorded",
};
const DEATH_NO_CONTACT: CahpsDeathFacts = {
  ...DEATH_OK,
  patientId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  admissionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const DEATH_NO_PE: CahpsDeathFacts = {
  ...DEATH_OK,
  patientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  admissionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  providerEntityId: null,
};

function pipeline(opts: {
  rows?: Record<string, unknown[]>;
  deaths?: CahpsDeathFacts[];
  contactFor?: (patientId: string) => Promise<{
    name: string;
    phone: string | null;
    email: string | null;
    preferredLanguageCode: string | null;
  } | null>;
}) {
  const { db, rec } = fakeDb(opts.rows ?? {});
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const deps: CahpsPipelineDeps = {
    db,
    cipher: createCahpsPhiCipher(keys()),
    adapterFactories: CAHPS_ADAPTER_FACTORIES,
    deathsForOrg: async () => opts.deaths ?? [],
    caregiverContactForOrg: async (_org, patientId) =>
      opts.contactFor
        ? opts.contactFor(patientId)
        : { name: "Jane Doe", phone: "555-0100", email: null, preferredLanguageCode: "en-US" },
    outboxPublisher: {
      publish: async (_tx, input) => {
        published.push({ eventName: input.eventName, payload: input.payload });
      },
    },
  };
  return { ports: buildCahpsPipelinePorts(deps), deps, rec, published };
}

describe("CAHPS pipeline helpers", () => {
  it("maps a calendar period to the half-open window the M6 port takes", () => {
    expect(periodToHalfOpen({ start: "2026-02-01", end: "2026-02-28" })).toEqual({
      from: "2026-02-01",
      to: "2026-03-01",
    });
  });

  it("treats no filed language as supported and any non-CMS language as unsupported", () => {
    expect(isSupportedLanguage(null)).toBe(true);
    expect(isSupportedLanguage("es-MX")).toBe(true);
    expect(isSupportedLanguage("fr")).toBe(false);
  });

  it("derives a stable v5-shaped uuid for an outbox aggregate id", () => {
    expect(uuidFromKey("a")).toBe(uuidFromKey("a"));
    expect(uuidFromKey("a")).not.toBe(uuidFromKey("b"));
    expect(uuidFromKey("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  it("reads the integer key version out of a DEK version string", () => {
    expect(keyVersionInt("v3")).toBe(3);
    expect(keyVersionInt("2026.v12")).toBe(12);
    expect(keyVersionInt("nodigits")).toBe(1);
  });
});

describe("CAHPS PHI cipher", () => {
  it("round-trips, binds the column + org, and keeps plaintext out of the envelope", async () => {
    const cipher = createCahpsPhiCipher(keys());
    const sealed = await cipher.encrypt(ORG, "cahps_export_job.file_cipher", "Jane Doe,555-0100");
    expect(sealed.envelope).not.toContain("Jane");
    expect(sealed.keyVersion).toBe(1);
    await expect(
      cipher.decrypt(ORG, "cahps_export_job.file_cipher", sealed.envelope),
    ).resolves.toEqual(Buffer.from("Jane Doe,555-0100"));
    await expect(
      cipher.decrypt(
        ORG,
        "cahps_decedent_sample.primary_caregiver_contact_cipher",
        sealed.envelope,
      ),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt(
        "99999999-9999-4999-8999-999999999999",
        "cahps_export_job.file_cipher",
        sealed.envelope,
      ),
    ).rejects.toThrow();
  });
});

describe("monthly sample cron over the real ports", () => {
  const NOW = new Date("2026-10-02T02:00:00.000Z");

  it("seals the caregiver contact into each sampled row, classifies exclusions, and emits sample_ready", async () => {
    const { ports, deps, rec, published } = pipeline({
      rows: {
        cahps_vendor_binding: [
          { id: BINDING, organizationId: ORG, vendorAdapterId: "manual", active: true },
        ],
      },
      deaths: [DEATH_OK, DEATH_NO_CONTACT, DEATH_NO_PE],
      contactFor: async (patientId) =>
        patientId === DEATH_NO_CONTACT.patientId
          ? null
          : { name: "Jane Doe", phone: "555-0100", email: null, preferredLanguageCode: "en-US" },
    });

    const report = await runCahpsMonthlySample({
      orgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      candidates: ports.candidates,
      samples: ports.samples,
      outbox: ports.sampleOutbox,
      now: () => NOW,
    });

    expect(report.samplePeriod).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(report.dispositions).toEqual([
      { organizationId: ORG, outcome: "sampled", sampled: 2 }, // the un-sited death is left for a later run
    ]);
    const rows = rec.inserts.filter((i) => i.table === "cahps_decedent_sample");
    expect(rows).toHaveLength(2);
    const eligible = rows.find((r) => r.values.deceasedAdmissionId === DEATH_OK.admissionId);
    const excluded = rows.find(
      (r) => r.values.deceasedAdmissionId === DEATH_NO_CONTACT.admissionId,
    );
    expect(eligible?.values.exclusionReason).toBeNull();
    expect(excluded?.values.exclusionReason).toBe("caregiver_unavailable");
    expect(eligible?.values.samplingCycleMonth).toBe("2026-09-01");
    expect(eligible?.values.providerEntityId).toBe(PE);
    // PHI is only ever in the envelope
    const envelope = String(eligible?.values.primaryCaregiverContactCipher);
    expect(envelope).not.toContain("Jane");
    const opened = JSON.parse(
      (
        await deps.cipher.decrypt(
          ORG,
          "cahps_decedent_sample.primary_caregiver_contact_cipher",
          envelope,
        )
      ).toString("utf8"),
    );
    expect(opened).toMatchObject({
      name: "Jane Doe",
      phone: "555-0100",
      language: "en",
      deathDate: "2026-09-10",
    });
    expect(published).toEqual([
      {
        eventName: "m30.cahps.sample_ready",
        payload: {
          orgId: ORG,
          samplePeriod: { start: "2026-09-01", end: "2026-09-30" },
          decedentCount: 2,
          vendor: "manual",
        },
      },
    ]);
  });

  it("skips an org with no active vendor binding", async () => {
    const { ports, rec } = pipeline({ deaths: [DEATH_OK] });
    const report = await runCahpsMonthlySample({
      orgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      candidates: ports.candidates,
      samples: ports.samples,
      outbox: ports.sampleOutbox,
      now: () => NOW,
    });
    expect(report.dispositions).toEqual([{ organizationId: ORG, outcome: "no_active_vendor" }]);
    expect(rec.inserts).toHaveLength(0);
  });
});

describe("vendor adapter + configuration resolution", () => {
  it("builds the manual adapter from an unconfigured binding", async () => {
    const { ports } = pipeline({
      rows: {
        cahps_vendor_binding: [
          {
            id: BINDING,
            organizationId: ORG,
            vendorAdapterId: "manual",
            active: true,
            configurationCipher: CAHPS_PENDING_CONFIGURATION,
          },
        ],
      },
    });
    const adapter = await ports.adapters.resolve(ORG);
    expect(adapter.vendor).toBe("manual");
    await expect(ports.bindingConfig.load(ORG, BINDING)).resolves.toEqual({});
  });

  it("refuses an org with no binding, and a vendor whose configuration is still the placeholder", async () => {
    const none = pipeline({});
    await expect(none.ports.adapters.resolve(ORG)).rejects.toMatchObject({
      code: "CAHPS_ADAPTER_UNCONFIGURED",
      statusCode: 503,
    });
    const shp = pipeline({
      rows: {
        cahps_vendor_binding: [
          {
            id: BINDING,
            organizationId: ORG,
            vendorAdapterId: "shp",
            active: true,
            configurationCipher: CAHPS_PENDING_CONFIGURATION,
          },
        ],
      },
    });
    await expect(shp.ports.adapters.resolve(ORG)).rejects.toMatchObject({
      code: "CAHPS_ADAPTER_UNCONFIGURED",
    });
  });

  it("opens a sealed configuration", async () => {
    const cipher = createCahpsPhiCipher(keys());
    const sealed = await cipher.encrypt(
      ORG,
      "cahps_vendor_binding.configuration_cipher",
      JSON.stringify({ accountId: "acct-1" }),
    );
    const { db } = fakeDb({
      cahps_vendor_binding: [
        {
          id: BINDING,
          organizationId: ORG,
          vendorAdapterId: "manual",
          active: true,
          configurationCipher: sealed.envelope,
        },
      ],
    });
    const ports = buildCahpsPipelinePorts({
      db,
      cipher,
      adapterFactories: CAHPS_ADAPTER_FACTORIES,
      deathsForOrg: async () => [],
      caregiverContactForOrg: async () => null,
    });
    await expect(ports.bindingConfig.load(ORG, BINDING)).resolves.toEqual({ accountId: "acct-1" });
  });
});

describe("vendor export worker over the real ports", () => {
  it("renders, stores the sealed artifact BEFORE the push, and completes the job row", async () => {
    const cipher = createCahpsPhiCipher(keys());
    const sealedContact = await cipher.encrypt(
      ORG,
      "cahps_decedent_sample.primary_caregiver_contact_cipher",
      JSON.stringify({
        name: "Jane Doe",
        phone: "555-0100",
        email: null,
        language: "en",
        deathDate: "2026-09-10",
      }),
    );
    const sampleRow = {
      id: "99999999-9999-4999-8999-999999999999",
      organizationId: ORG,
      providerEntityId: PE,
      samplingCycleMonth: "2026-09-01",
      deceasedAdmissionId: DEATH_OK.admissionId,
      deceasedPatientId: DEATH_OK.patientId,
      primaryCaregiverContactCipher: sealedContact.envelope,
      primaryCaregiverContactKeyVersion: 1,
      exclusionReason: null,
      status: "pending_export",
    };
    const { db, rec } = fakeDb({
      cahps_vendor_binding: [
        {
          id: BINDING,
          organizationId: ORG,
          vendorAdapterId: "manual",
          active: true,
          configurationCipher: CAHPS_PENDING_CONFIGURATION,
        },
      ],
    });
    const published: string[] = [];
    const ports = buildCahpsPipelinePorts({
      db,
      cipher,
      adapterFactories: CAHPS_ADAPTER_FACTORIES,
      deathsForOrg: async () => [],
      caregiverContactForOrg: async () => null,
      outboxPublisher: {
        publish: async (_tx, input) => {
          published.push(input.eventName);
        },
      },
    });
    const order: string[] = [];
    const exports = {
      markRunning: vi.fn(async (j: CahpsExportJob) => {
        order.push("running");
        await ports.exports.markRunning(j);
      }),
      storeFile: vi.fn(
        async (j: CahpsExportJob, f: Parameters<typeof ports.exports.storeFile>[1], n: number) => {
          order.push("store");
          await ports.exports.storeFile(j, f, n);
        },
      ),
      complete: vi.fn(
        async (j: CahpsExportJob, p: Parameters<typeof ports.exports.complete>[1]) => {
          order.push("complete");
          await ports.exports.complete(j, p);
        },
      ),
      fail: vi.fn(async () => {}),
    };
    const marked: string[] = [];
    const run = cahpsExportProcessor({
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      adapters: {
        resolve: async (orgId) => {
          order.push("resolve");
          return ports.adapters.resolve(orgId);
        },
      },
      samples: {
        listPendingForCycle: async () => [sampleRow as never],
        markExported: async (id) => {
          marked.push(id);
        },
        markExportFailed: async () => {},
      },
      decrypt: ports.decrypt,
      bindingConfig: ports.bindingConfig,
      outbox: ports.exportOutbox,
      exports,
      now: () => new Date("2026-10-05T00:00:00.000Z"),
    });

    const job: CahpsExportJob = {
      jobId: EXPORT_ID,
      exportId: EXPORT_ID,
      organizationId: ORG,
      samplingCycleMonth: "2026-09-01",
      samplePeriodStart: "2026-09-01",
      samplePeriodEnd: "2026-09-30",
      vendorBindingId: BINDING,
    };
    const result = await run(job);

    expect(result).toEqual({ outcome: "exported", exportedCount: 1, pushed: false });
    expect(order).toEqual(["running", "resolve", "store", "complete"]);
    expect(marked).toEqual([sampleRow.id]);
    expect(published).toEqual(["m30.cahps.export_completed"]);
    // the stored artifact is a sealed envelope that opens to the vendor CSV
    const stored = rec.updates.find((u) => u.table === "cahps_export_job" && u.set.fileCipher);
    expect(String(stored?.set.fileCipher)).not.toContain("Jane");
    const csv = (
      await cipher.decrypt(ORG, "cahps_export_job.file_cipher", String(stored?.set.fileCipher))
    ).toString("utf8");
    expect(csv).toContain("Jane Doe");
    expect(csv).toContain("2026-09-10");
    expect(stored?.set.decedentCount).toBe(1);
    const done = rec.updates.find(
      (u) => u.table === "cahps_export_job" && u.set.status === "completed",
    );
    expect(done?.set).toMatchObject({ pushStatus: "no_push", vendorJobId: null });
  });

  it("marks the job failed (and re-throws) when no adapter can be resolved", async () => {
    const fail = vi.fn(async () => {});
    const run = cahpsExportProcessor({
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      adapters: {
        resolve: async () => {
          throw new Error("no active CAHPS vendor binding");
        },
      },
      samples: {
        listPendingForCycle: async () => [],
        markExported: async () => {},
        markExportFailed: async () => {},
      },
      decrypt: { toVendorRow: async () => ({}) as never },
      bindingConfig: { load: async () => ({}) },
      outbox: { emitExportCompleted: async () => {}, emitExportFailed: async () => {} },
      exports: {
        markRunning: async () => {},
        storeFile: async () => {},
        complete: async () => {},
        fail,
      },
      now: () => new Date(),
    });
    await expect(
      run({
        jobId: EXPORT_ID,
        exportId: EXPORT_ID,
        organizationId: ORG,
        samplingCycleMonth: "2026-09-01",
        samplePeriodStart: "2026-09-01",
        samplePeriodEnd: "2026-09-30",
        vendorBindingId: BINDING,
      }),
    ).rejects.toThrow("no active CAHPS vendor binding");
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ exportId: EXPORT_ID }),
      "no active CAHPS vendor binding",
    );
  });
});
