// M38 loader — the version-load orchestrator over in-memory ports (GAP-108): load → stage → active, checksum
// mismatch fails with no staging residue, resume from staged, idempotent re-run, licence refusal, retry-vs-fail
// error taxonomy, follow-up fan-out, and the scheduled-source refusals.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/bytes";
import { LicensedSourceCredentialMissingError } from "../src/errors";
import {
  createInMemoryLoaderStore,
  createInMemoryObjects,
  createRecordingFollowUps,
} from "../src/in-memory";
import { type LoadVersionDeps, runLoadVersion } from "../src/load";
import { SILENT_LOGGER } from "../src/ports";
import { runScheduledActivation, runScheduledSource } from "../src/scheduled";
import { PUBLIC_SOURCE_ADAPTERS, licensedSourceDenyStub } from "../src/sources/index";
import { ICD10CM_ORDER_2026, ICD10CM_ORDER_2027, LOINC_CSV, bytes, zip } from "./_fixtures";

function rig(opts: { embeddings?: boolean; licenseSources?: Record<string, string> } = {}) {
  const store = createInMemoryLoaderStore({ licenseSources: opts.licenseSources as never });
  const objects = createInMemoryObjects();
  const followUps = createRecordingFollowUps();
  const deps: LoadVersionDeps = {
    store: store.port,
    objects,
    followUps,
    log: SILENT_LOGGER,
    today: () => "2026-10-06",
    embeddingsAvailable: opts.embeddings ?? false,
  };
  async function register(
    system: "icd10cm" | "loinc",
    version: string,
    effectiveFrom: string,
    file: Uint8Array,
    checksum?: string,
  ) {
    const key = `terminology/${system}/${version}`;
    objects.objects.set(key, file);
    const reg = await store.port.registerVersion({
      system,
      version,
      sourceFileRef: key,
      checksum: checksum ?? sha256Hex(file),
      releasedOn: "2026-06-01",
      effectiveFrom,
      loadedBy: null,
    });
    return reg.versionId;
  }
  return { store, objects, followUps, deps, register };
}

describe("runLoadVersion", () => {
  it("loads, stages, activates, supersedes the prior version and fans out follow-ups", async () => {
    const r = rig({ embeddings: true });
    const v26 = await r.register("icd10cm", "FY2026", "2025-10-01", bytes(ICD10CM_ORDER_2026));
    expect((await runLoadVersion(r.deps, { versionId: v26 })).outcome).toBe("activated");
    const v27 = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    const out = await runLoadVersion(r.deps, { versionId: v27 });

    expect(out).toMatchObject({ outcome: "activated", activation: { supersededVersionId: v26 } });
    expect(r.store.versions.get(v26)?.status).toBe("superseded");
    expect(r.store.versions.get(v27)?.status).toBe("active");
    // two versions coexist; the older one's concept rows are untouched
    expect(r.store.concepts.get(v26)).toHaveLength(5);
    expect(r.store.concepts.get(v27)).toHaveLength(6);
    // staging is emptied on activation
    expect(r.store.staging.has(v27)).toBe(false);
    // I42.0 (billable → header) and Z51.5 (deleted) are deprecations of FY2027
    expect(
      r.store.deprecations
        .filter((d) => d.versionId === v27)
        .map((d) => d.code)
        .sort(),
    ).toEqual(["I42.0", "Z51.5"]);
    expect(r.followUps.calls).toEqual(
      expect.arrayContaining([
        `expansions:icd10cm:${v27}`,
        `embeddings:icd10cm:${v27}`,
        `scan:icd10cm:${v27}`,
      ]),
    );
  });

  it("fails a checksum mismatch with NO staging residue and no concept rows", async () => {
    const r = rig();
    const id = await r.register(
      "icd10cm",
      "FY2027",
      "2026-10-01",
      bytes(ICD10CM_ORDER_2027),
      "0".repeat(64),
    );
    const out = await runLoadVersion(r.deps, { versionId: id });
    expect(out).toMatchObject({ outcome: "failed" });
    expect((out as { reason: string }).reason).toMatch(/CHECKSUM_MISMATCH/);
    expect(r.store.versions.get(id)?.status).toBe("failed");
    expect(r.store.staging.has(id)).toBe(false);
    expect(r.store.concepts.has(id)).toBe(false);
    expect(r.followUps.calls).toEqual([]);
  });

  it("fails an unparsable source and cleans partially staged rows", async () => {
    const r = rig();
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes("not an order file"));
    expect((await runLoadVersion(r.deps, { versionId: id })).outcome).toBe("failed");
    expect(r.store.staging.has(id)).toBe(false);
    expect(r.store.failures[0]?.reason).toMatch(/fixed-width/);
  });

  it("fails a missing source object as a data fault", async () => {
    const r = rig();
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    r.objects.objects.clear();
    expect(await runLoadVersion(r.deps, { versionId: id })).toMatchObject({ outcome: "failed" });
  });

  it("rethrows a transport error and leaves the version loading (the queue retries)", async () => {
    const r = rig();
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    const boom = {
      ...r.deps,
      objects: {
        ...r.objects,
        read: async () => {
          throw new Error("connect ECONNRESET");
        },
      },
    };
    await expect(runLoadVersion(boom, { versionId: id })).rejects.toThrow(/ECONNRESET/);
    expect(r.store.versions.get(id)?.status).toBe("loading");
    expect(r.store.failures).toEqual([]);
  });

  it("resumes from staged without re-reading or re-parsing the source", async () => {
    const r = rig();
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    const dry = await runLoadVersion(r.deps, { versionId: id, activate: false });
    expect(dry.outcome).toBe("staged");
    expect(r.store.versions.get(id)?.status).toBe("staged");
    expect(r.objects.reads).toHaveLength(1);

    const resumed = await runLoadVersion(r.deps, { versionId: id });
    expect(resumed).toMatchObject({ outcome: "activated", stage: null });
    expect(r.objects.reads).toHaveLength(1); // not read again
    expect(r.store.versions.get(id)?.status).toBe("active");
  });

  it("is idempotent: re-running an activated or failed version is a no-op", async () => {
    const r = rig();
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    await runLoadVersion(r.deps, { versionId: id });
    const calls = r.followUps.calls.length;
    expect(await runLoadVersion(r.deps, { versionId: id })).toEqual({
      outcome: "noop",
      status: "active",
    });
    expect(r.followUps.calls).toHaveLength(calls);
  });

  it("refuses a licensed system without an attestation, and loads it with one", async () => {
    const r = rig({ licenseSources: { loinc: "regenstrief" } });
    const file = zip({ "LoincTable/Loinc.csv": LOINC_CSV });
    const id = await r.register("loinc", "2.78", "2026-08-01", file);
    const refused = await runLoadVersion(r.deps, { versionId: id });
    expect(refused).toMatchObject({ outcome: "failed" });
    expect((refused as { reason: string }).reason).toMatch(/ATTESTATION_REQUIRED/);

    const id2 = await r.register("loinc", "2.79", "2026-09-01", file);
    r.store.addAttestation({
      id: "a1",
      system: "loinc",
      licensee: "ChartWarden",
      licenseReference: "LOINC-REF-9",
      attestedBy: "op",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      attributionText: "LOINC is copyright Regenstrief Institute.",
      revokedAt: null,
    });
    expect((await runLoadVersion(r.deps, { versionId: id2 })).outcome).toBe("activated");
  });

  it("skips the embeddings follow-up (and says so) when no embeddings backend is bound", async () => {
    const r = rig({ embeddings: false });
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    await runLoadVersion(r.deps, { versionId: id });
    expect(r.followUps.calls.some((c) => c.startsWith("embeddings:"))).toBe(false);
    expect(r.followUps.calls.some((c) => c.startsWith("expansions:"))).toBe(true);
  });
});

describe("runScheduledSource", () => {
  const base = () => {
    const r = rig();
    return {
      r,
      deps: {
        store: r.store.port,
        objects: r.objects,
        followUps: r.followUps,
        log: SILENT_LOGGER,
        now: () => new Date("2026-09-15T04:00:00Z"),
        fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
        egressEnabled: true,
        publicAdapters: PUBLIC_SOURCE_ADAPTERS,
        licensed: licensedSourceDenyStub,
      },
    };
  };

  it("does not fetch a tier-1 source while the egress flag is off", async () => {
    const { deps } = base();
    let fetched = 0;
    const out = await runScheduledSource(
      {
        ...deps,
        egressEnabled: false,
        fetchImpl: (async () => {
          fetched++;
          return new Response("");
        }) as typeof fetch,
      },
      "icd10cm",
      { mode: "dry_run", activate: false },
    );
    expect(out).toEqual({ outcome: "skipped", reason: "egress_disabled" });
    expect(fetched).toBe(0);
  });

  it("fetches the next fiscal year, stores it in the platform bucket, registers and enqueues a STAGE-ONLY load", async () => {
    const { r, deps } = base();
    const urls: string[] = [];
    const zipBytes = zip({ "icd10cm-order-2027.txt": ICD10CM_ORDER_2027 });
    const out = await runScheduledSource(
      {
        ...deps,
        fetchImpl: (async (u: string) => {
          urls.push(u);
          return new Response(zipBytes);
        }) as unknown as typeof fetch,
      },
      "icd10cm",
      { mode: "dry_run", activate: false },
    );
    expect(urls[0]).toContain("/2027/");
    expect(out).toMatchObject({ outcome: "enqueued", version: "FY2027" });
    const [key] = [...r.objects.objects.keys()];
    expect(key).toMatch(/^terminology\/icd10cm\/FY2027\/[0-9a-f]{64}$/);
    const id = (out as { versionId: string }).versionId;
    expect(r.followUps.calls).toContain(`load:${id}:false`);
    // an unchanged source on the next run is not re-registered
    const again = await runScheduledSource(
      { ...deps, fetchImpl: (async () => new Response(zipBytes)) as unknown as typeof fetch },
      "icd10cm",
      { mode: "dry_run", activate: false },
    );
    expect(again).toEqual({ outcome: "skipped", reason: "unchanged" });
  });

  it("refuses tier-2 sources: no attestation -> license skip; attestation but deny-stub -> credentials_not_configured", async () => {
    const { r, deps } = base();
    const lic = {
      ...deps,
      store: createInMemoryLoaderStore({ licenseSources: { snomed: "umls" } }),
    };
    expect(
      await runScheduledSource({ ...deps, store: lic.store.port }, "snomed", {
        mode: "current",
        activate: true,
      }),
    ).toEqual({ outcome: "skipped", reason: "license_ATTESTATION_REQUIRED" });
    lic.store.addAttestation({
      id: "a1",
      system: "snomed",
      licensee: "ChartWarden",
      licenseReference: "REF",
      attestedBy: "op",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      attributionText: "SNOMED CT ...",
      revokedAt: null,
    });
    expect(
      await runScheduledSource({ ...deps, store: lic.store.port }, "snomed", {
        mode: "current",
        activate: true,
      }),
    ).toEqual({ outcome: "skipped", reason: "credentials_not_configured" });
    expect(r.followUps.calls).toEqual([]);
    await expect(
      licensedSourceDenyStub.fetchLatest("loinc", {
        now: new Date(),
        fetchImpl: fetch,
        mode: "current",
      }),
    ).rejects.toBeInstanceOf(LicensedSourceCredentialMissingError);
  });

  it("has no adapter for upload-only systems and bundles the revenue hospice subset without egress", async () => {
    const { r, deps } = base();
    expect(await runScheduledSource(deps, "hcpcs", { mode: "current", activate: true })).toEqual({
      outcome: "skipped",
      reason: "no_adapter",
    });
    const out = await runScheduledSource({ ...deps, egressEnabled: false }, "revenue", {
      mode: "current",
      activate: true,
    });
    expect(out).toMatchObject({ outcome: "enqueued" });
    const id = (out as { versionId: string }).versionId;
    expect((await runLoadVersion({ ...r.deps }, { versionId: id })).outcome).toBe("activated");
    expect(r.store.concepts.get(id)?.map((c) => c.code)).toEqual([
      "0250",
      "0651",
      "0652",
      "0655",
      "0656",
      "0657",
    ]);
  });

  it("queues the staged version for activation (the Oct 1 run) and reports when nothing is staged", async () => {
    const { r, deps } = base();
    expect(await runScheduledActivation(deps, "icd10cm")).toEqual({
      outcome: "skipped",
      reason: "nothing_staged",
    });
    const id = await r.register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    await runLoadVersion(r.deps, { versionId: id, activate: false });
    expect(await runScheduledActivation(deps, "icd10cm")).toMatchObject({
      outcome: "enqueued",
      versionId: id,
    });
    expect(r.followUps.calls).toContain(`load:${id}:true`);
  });
});
