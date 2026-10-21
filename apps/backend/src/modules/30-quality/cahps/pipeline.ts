// apps/backend/src/modules/30-quality/cahps/pipeline.ts — GAP-087. The REAL ports behind M30's CAHPS-Hospice
// pipeline (§7.2 WF-04 monthly sample + W-14 vendor export), replacing the `unboundWorkerPort` thunks that made
// every run throw:
//
//   SAMPLE (cron):   death census (M6 port) → caregiver contact (M5 port) → pure CMS classifier → sealed insert
//                    into `cahps_decedent_sample` (tenant-DEK envelope, AAD-bound) → `m30.cahps.sample_ready`.
//   EXPORT (worker): active binding + sealed vendor config → adapter from `@wardenx/cahps-vendors` → decrypt the
//                    sample rows to the in-flight vendor shape → render → STORE the sealed artifact on the
//                    `cahps_export_job` row → push (SHP) / no_push (manual) → stamp rows → `export_completed`.
//
// Cross-module data (deaths, caregiver contact) arrives through two PORTS injected at the composition root, so
// M30 reads no M5/M6 table and gains no manifest edge (the F-160 `CapConsumerStore` shape). Every statement runs
// in `withOrgContext` on the row's own org (RLS) with the system actor ('' → NULL in the M4 trigger).
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import type {
  CahpsAdapterResolutionMap,
  CahpsAdapterResolvePort,
  CahpsBindingConfigPort,
  CahpsCaregiverDecryptPort,
  CahpsDecedentSampleRow,
  CahpsExportJobPort,
  CahpsExportOutboxPort,
  CahpsSampleCandidate,
  CahpsSamplePeriod,
  CahpsSampleReadyOutboxPort,
  CahpsSampleWritePort,
  CahpsVendorAdapter,
  CahpsVendorAdapterId,
  DecedentCandidateReadPort,
  DecedentDeathSource,
} from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";
import { ChartWardenError } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { buildCahpsExportJobPort } from "./export-job-store";
import type { CahpsPhiCipher } from "./phi-cipher";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const SYSTEM_USER_ID = "";
const B = schema.cahpsVendorBinding;
const S = schema.cahpsDecedentSample;

/** The sentinel `bindCahpsVendor` stores until a vendor configuration is supplied (nothing sealed yet). */
export const CAHPS_PENDING_CONFIGURATION = "pending_secure_configuration";

/** CMS-supported CAHPS-Hospice survey languages (ISO-639-1): English, Spanish, Chinese, Russian, Portuguese,
 *  Vietnamese, Polish. A caregiver whose filed language is outside the set is a CMS exclusion. */
export const CAHPS_SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  "en",
  "es",
  "zh",
  "ru",
  "pt",
  "vi",
  "pl",
]);

/** The caregiver facts the sampler needs (the M5 port's shape — a locally-declared structural type). */
export interface CahpsCaregiverContact {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly preferredLanguageCode: string | null;
}

/** One death in the sample window with its stay facts (the M6 port's shape). */
export interface CahpsDeathFacts {
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string | null;
  readonly admissionStartAt: Date;
  readonly deathAt: Date;
  readonly source: "internal_clinician_recorded" | "hl7_external";
}

export interface CahpsPipelineDeps {
  readonly db: DbClient;
  readonly cipher: CahpsPhiCipher;
  /** `@wardenx/cahps-vendors`' `CAHPS_ADAPTER_FACTORIES` — injected so M30 jobs import no vendor class. */
  readonly adapterFactories: CahpsAdapterResolutionMap;
  /** M6 — deaths in `[from, to)` with stay facts (`cahpsDeathCandidatesForOrg`). */
  readonly deathsForOrg: (
    organizationId: string,
    period: { readonly from: string; readonly to: string },
  ) => Promise<ReadonlyArray<CahpsDeathFacts>>;
  /** M5 — the patient's primary caregiver contact (`primaryCaregiverContactForOrg`). */
  readonly caregiverContactForOrg: (
    organizationId: string,
    patientId: string,
  ) => Promise<CahpsCaregiverContact | null>;
  /** The tx-scoped `m30` outbox publisher (the SAME instance the command routes publish through). */
  readonly outboxPublisher?: {
    publish(
      tx: DbClient,
      input: {
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
        readonly organizationId: string;
        readonly aggregateKind: string;
        readonly aggregateId: string;
      },
    ): Promise<void>;
  };
  readonly now?: () => Date;
}

/** What is sealed in `primary_caregiver_contact_cipher` — everything the vendor row needs that is PHI. */
interface SealedContact {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly language: string | null;
  readonly deathDate: string;
}

/** A stable UUID (v5-shaped) over a business key — the outbox `aggregate_id` is a uuid column. */
export function uuidFromKey(key: string): string {
  const h = createHash("sha1").update(key).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const inOrg = <T>(db: DbClient, organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) => fn(tx as Tx));

/** ISO-639 → the two-letter primary subtag, lowercased; null when nothing usable. */
export function normalizeLanguage(code: string | null): string | null {
  const t = code?.trim().toLowerCase();
  if (!t) return null;
  return t.slice(0, 2);
}

/** A language is supported when none is filed (the survey defaults to English) or it is on the CMS list. */
export function isSupportedLanguage(code: string | null): boolean {
  const lang = normalizeLanguage(code);
  return lang === null || CAHPS_SUPPORTED_LANGUAGES.has(lang);
}

const mapDeathSource = (s: CahpsDeathFacts["source"]): DecedentDeathSource =>
  s === "hl7_external" ? "external_import" : "admission_discharge";

/** `[start, end]` inclusive dates → the `[from, to)` window the M6 port takes. */
export function periodToHalfOpen(period: CahpsSamplePeriod): { from: string; to: string } {
  const end = new Date(`${period.end}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: period.start, to: end.toISOString().slice(0, 10) };
}

export function buildCahpsPipelinePorts(deps: CahpsPipelineDeps): {
  readonly candidates: DecedentCandidateReadPort;
  readonly samples: CahpsSampleWritePort;
  readonly sampleOutbox: CahpsSampleReadyOutboxPort;
  readonly adapters: CahpsAdapterResolvePort;
  readonly decrypt: CahpsCaregiverDecryptPort;
  readonly bindingConfig: CahpsBindingConfigPort;
  readonly exportOutbox: CahpsExportOutboxPort;
  readonly exports: CahpsExportJobPort;
} {
  const now = deps.now ?? (() => new Date());

  // `listPriorMonthDecedents` and `insertSampled` run back-to-back inside one cron pass; the death date the
  // sealed contact carries is remembered per (org, admission) between them (it is not on `SampledDecedent`).
  const deathDates = new Map<string, string>();
  const deathKey = (organizationId: string, admissionId: string): string =>
    `${organizationId}:${admissionId}`;

  const loadActiveBinding = (organizationId: string) =>
    inOrg(deps.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(B)
        .where(and(eq(B.organizationId, organizationId), eq(B.active, true)))
        .limit(1);
      return row ?? null;
    });

  const openConfig = async (
    organizationId: string,
    binding: { configurationCipher: string },
  ): Promise<Record<string, unknown>> => {
    if (binding.configurationCipher === CAHPS_PENDING_CONFIGURATION) return {};
    const plain = await deps.cipher.decrypt(
      organizationId,
      "cahps_vendor_binding.configuration_cipher",
      binding.configurationCipher,
    );
    const parsed: unknown = JSON.parse(plain.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ChartWardenError(
        "CAHPS_ADAPTER_UNCONFIGURED",
        "the CAHPS vendor configuration is not a JSON object",
        503,
      );
    }
    return parsed as Record<string, unknown>;
  };

  const publish = (
    organizationId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const publisher = deps.outboxPublisher;
    if (!publisher) {
      throw new ChartWardenError(
        "CAHPS_OUTBOX_UNBOUND",
        `no outbox publisher is bound — cannot emit ${eventName}`,
        503,
      );
    }
    return inOrg(deps.db, organizationId, (tx) =>
      publisher.publish(tx as unknown as DbClient, {
        eventName,
        payload,
        organizationId,
        aggregateKind,
        aggregateId,
      }),
    );
  };

  const candidates: DecedentCandidateReadPort = {
    async listPriorMonthDecedents(orgId, period) {
      const deaths = await deps.deathsForOrg(orgId, periodToHalfOpen(period));
      const out: CahpsSampleCandidate[] = [];
      for (const d of deaths) {
        // A death on an admission never sited to a provider entity cannot be stamped on the sample row (the
        // column is NOT NULL and the pipeline must not guess one) — it is left for the next sited run.
        if (d.providerEntityId === null) continue;
        const contact = await deps.caregiverContactForOrg(orgId, d.patientId);
        deathDates.set(deathKey(orgId, d.admissionId), d.deathAt.toISOString().slice(0, 10));
        out.push({
          deceasedPatientId: d.patientId,
          deceasedAdmissionId: d.admissionId,
          providerEntityId: d.providerEntityId,
          deathDate: d.deathAt.toISOString().slice(0, 10),
          admissionStartAt: d.admissionStartAt.toISOString(),
          deathAt: d.deathAt.toISOString(),
          deathSource: mapDeathSource(d.source),
          // A caregiver is "available" only when at least one survey channel (phone or email) is on file.
          caregiverAvailable:
            contact !== null && (contact.phone !== null || contact.email !== null),
          languageSupported:
            contact === null ? true : isSupportedLanguage(contact.preferredLanguageCode),
          // No table records a caregiver's CAHPS no-contact request; the R-13 manual exclusion is that path.
          priorSurveyOptOut: false,
        });
      }
      return out;
    },
  };

  const samples: CahpsSampleWritePort = {
    async activeVendorBinding(orgId) {
      const binding = await loadActiveBinding(orgId);
      return binding === null
        ? null
        : { vendorBindingId: binding.id, vendor: binding.vendorAdapterId };
    },
    async insertSampled(orgId, sampled) {
      const contact = await deps.caregiverContactForOrg(orgId, sampled.deceasedPatientId);
      const key = deathKey(orgId, sampled.deceasedAdmissionId);
      const deathDate = deathDates.get(key);
      if (deathDate === undefined) {
        throw new ChartWardenError(
          "CAHPS_SAMPLE_STATE",
          "a sampled decedent has no remembered death date (insertSampled before listPriorMonthDecedents)",
          500,
        );
      }
      const sealedContact: SealedContact = {
        name: contact?.name ?? null,
        phone: contact?.phone ?? null,
        email: contact?.email ?? null,
        language: normalizeLanguage(contact?.preferredLanguageCode ?? null),
        deathDate,
      };
      const sealed = await deps.cipher.encrypt(
        orgId,
        "cahps_decedent_sample.primary_caregiver_contact_cipher",
        JSON.stringify(sealedContact),
      );
      await inOrg(deps.db, orgId, (tx) =>
        tx
          .insert(S)
          .values({
            organizationId: orgId,
            providerEntityId: sampled.providerEntityId,
            samplingCycleMonth: sampled.samplingCycleMonth,
            deceasedAdmissionId: sampled.deceasedAdmissionId,
            deceasedPatientId: sampled.deceasedPatientId,
            primaryCaregiverContactCipher: sealed.envelope,
            primaryCaregiverContactKeyVersion: sealed.keyVersion,
            exclusionReason: sampled.exclusionReason,
          })
          // uq_cahps_sample_decedent: a re-run of the cron for the same cycle converges, never duplicates.
          .onConflictDoNothing(),
      );
      deathDates.delete(key);
    },
  };

  const sampleOutbox: CahpsSampleReadyOutboxPort = {
    emitSampleReady: (payload) =>
      publish(
        payload.orgId,
        "m30.cahps.sample_ready",
        "cahps_decedent_sample",
        // One event per org + cycle: the aggregate id is the org (the sample is a roster, not one row).
        payload.orgId,
        { ...payload },
      ),
  };

  const adapters: CahpsAdapterResolvePort = {
    async resolve(orgId): Promise<CahpsVendorAdapter> {
      const binding = await loadActiveBinding(orgId);
      if (binding === null) {
        throw new ChartWardenError(
          "CAHPS_ADAPTER_UNCONFIGURED",
          `no active CAHPS vendor binding for org '${orgId}'`,
          503,
        );
      }
      const factory = deps.adapterFactories[binding.vendorAdapterId as CahpsVendorAdapterId];
      if (factory === undefined) {
        throw new ChartWardenError(
          "CAHPS_VENDOR_UNKNOWN",
          `no CAHPS adapter factory for vendor '${binding.vendorAdapterId}'`,
          500,
        );
      }
      const config = await openConfig(orgId, binding);
      const adapter = factory(config);
      const verdict = await adapter.validateConfig(config);
      if (!verdict.ok) {
        throw new ChartWardenError(
          "CAHPS_ADAPTER_UNCONFIGURED",
          `the CAHPS vendor configuration is invalid: ${verdict.errors
            .map((e) => `${e.field}: ${e.reason}`)
            .join("; ")}`,
          503,
        );
      }
      return adapter;
    },
  };

  const decrypt: CahpsCaregiverDecryptPort = {
    async toVendorRow(row): Promise<CahpsDecedentSampleRow> {
      const plain = await deps.cipher.decrypt(
        row.organizationId,
        "cahps_decedent_sample.primary_caregiver_contact_cipher",
        row.primaryCaregiverContactCipher,
      );
      const c = JSON.parse(plain.toString("utf8")) as SealedContact;
      return {
        decedentId: row.id,
        deceasedDate: c.deathDate,
        primaryCaregiverName: c.name ?? "",
        primaryCaregiverPhone: c.phone,
        primaryCaregiverEmail: c.email,
        exclusionReason: row.exclusionReason,
        languagePreference: c.language ?? "en",
      };
    },
  };

  const bindingConfig: CahpsBindingConfigPort = {
    async load(orgId, vendorBindingId) {
      const binding = await inOrg(deps.db, orgId, async (tx) => {
        const [row] = await tx
          .select()
          .from(B)
          .where(and(eq(B.organizationId, orgId), eq(B.id, vendorBindingId)))
          .limit(1);
        return row ?? null;
      });
      if (binding === null) {
        throw new ChartWardenError(
          "CAHPS_ADAPTER_UNCONFIGURED",
          "the CAHPS vendor binding is gone",
          503,
        );
      }
      return openConfig(orgId, binding);
    },
  };

  const exportOutbox: CahpsExportOutboxPort = {
    emitExportCompleted: (payload) =>
      publish(payload.orgId, "m30.cahps.export_completed", "cahps_export_job", payload.exportId, {
        ...payload,
      }),
    emitExportFailed: (payload) =>
      publish(
        payload.orgId,
        "m30.cahps.export_failed",
        "cahps_export_job",
        // A failure event has no job id in its package payload; key it by org + period start (idempotent).
        uuidFromKey(`${payload.orgId}:${payload.samplePeriod.start}`),
        { ...payload },
      ),
  };

  return {
    candidates,
    samples,
    sampleOutbox,
    adapters,
    decrypt,
    bindingConfig,
    exportOutbox,
    exports: buildCahpsExportJobPort({ db: deps.db, cipher: deps.cipher, now }),
  };
}
