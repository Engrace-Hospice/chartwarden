// apps/backend/src/modules/23-billing-medicare/jobs/hets-eligibility.ts — the BOUND HETS 270/271
// eligibility port (M23 §4.4 / §4.8 `eligibility.refresh`) + its env configuration.
//
// One check = unlock the MBI through M5's `MbiUnlockReader` (M23-only seam) → build the 270 in memory →
// drop the subscriber identity → exchange over the configured HETS transport → parse the 271 → derive the
// hospice election / benefit-period history. The MBI exists only inside `check()` (and inside the 270
// string handed to the transport); nothing here logs, persists or returns it. JS strings are immutable, so
// "zeroing" (§8.7 `safeZero`) is done by releasing every reference the moment the 270 is built — the result
// object is additionally run through `assertNoMbi` before it leaves this file.
//
// The raw 271 is NOT stored: HETS echoes the submitted MBI in 2100C NM1*IL (Companion Guide Table 26), so
// keeping the file would persist the MBI (D13). `responseFileUri` is therefore always null.
//
// Configuration (env, platform-level — the HETS Submitter ID belongs to the trading partner, i.e. this
// platform or its clearinghouse, with each hospice NPI linked to it in HETS Desktop; it is not a per-tenant
// MAC credential like `mac_submitter_credential`):
//   M23_HETS_TRANSPORT     unset → UNBOUND (eligibility checks stay 503) | `core_mime` | `sandbox`
//   M23_HETS_ENDPOINT_URL  https endpoint (CMS HETS MIME URL or the clearinghouse/NSV's)      [core_mime]
//   M23_HETS_SUBMITTER_ID  the CMS-issued HETS Submitter ID                                   [core_mime]
//   M23_HETS_AUTH_TOKEN    bearer token for a clearinghouse/NSV endpoint                      [core_mime, or]
//   M23_HETS_CLIENT_CERT_FILE / M23_HETS_CLIENT_KEY_FILE  PEM files for direct-to-CMS mutual TLS   [core_mime]
//   M23_HETS_USAGE         `P` (default) or `T` — the ISA15 usage indicator
//   M23_HETS_TIMEOUT_MS    1000–120000 (default 60000; HETS answers AAA 42 past 60 s)
//   M23_HETS_SANDBOX_SCENARIO  optional fixed scenario for the sandbox transport
// `sandbox` is refused when NODE_ENV=production — synthetic eligibility must never reach a real tenant.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EligibilityOutcome } from "@wardenx/billing";
import type { EligibilitySubscriberIdentity, MbiUnlockReader } from "@wardenx/types";
import {
  HETS_271_SCENARIOS,
  type Hets271Outcome,
  type Hets271Scenario,
  type HetsTransport,
  HetsTransportError,
  assertNoMbi,
  build270,
  createCoreMimeHetsTransport,
  createSandboxHetsTransport,
  deriveHospiceHistory,
  parse271,
} from "@wardenx/x12-837-client";
import type { HetsEligibilityPort, HetsEligibilityResult } from "./m23-jobs";

/** Days an eligibility result stays fresh (M23 §11.A `eligibility_check_freshness_30d`). */
export const ELIGIBILITY_FRESHNESS_DAYS = 30;
const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** The provider identity the 270's 2100B loop needs (M1-owned `provider_entity`, read in the composition root). */
export interface HetsProviderPort {
  providerForEligibility(
    organizationId: string,
    providerEntityId: string,
  ): Promise<{ readonly npi: string; readonly organizationName: string } | null>;
}

export interface HetsEligibilityPortDeps {
  readonly transport: HetsTransport;
  readonly submitterId: string;
  readonly usage: "P" | "T";
  /** Resolved lazily per call (registration order at boot never matters). */
  readonly mbiUnlock: () => MbiUnlockReader;
  readonly providers: HetsProviderPort;
  readonly now?: () => Date;
}

/** HETS 271 outcome (DB spelling) → the M23 domain `EligibilityOutcome`. */
const DOMAIN_OUTCOME: Record<Hets271Outcome, EligibilityOutcome> = {
  active_part_a: "active_part_a",
  inactive_part_a: "inactive_part_a",
  mbi_invalid: "mbi_invalid",
  unknown_response: "indeterminate",
  hets_error: "error",
};

/** A 9-digit interchange control number from the clock + randomness (unique enough per 270). */
function controlNumber(now: Date): number {
  return ((now.getTime() % 900_000_000) + Math.floor(Math.random() * 99_999)) % 999_999_999 || 1;
}

/** Build the bound {@link HetsEligibilityPort}. */
export function buildHetsEligibilityPort(deps: HetsEligibilityPortDeps): HetsEligibilityPort {
  const now = deps.now ?? (() => new Date());
  return {
    async check(input) {
      const checkedAt = now();
      const fresh = new Date(checkedAt.getTime() + ELIGIBILITY_FRESHNESS_DAYS * DAY_MS);
      const traceNumber = randomUUID().replaceAll("-", "").slice(0, 30);
      const base = {
        partAEffectiveDate: null,
        partATerminationDate: null,
        hospiceElectionOnFile: false,
        hospice: null,
        rejectionCodes: [],
        transport: deps.transport.kind,
        correlationId: traceNumber,
        responseFileUri: null,
      } satisfies Partial<HetsEligibilityResult>;
      // A failed round-trip is recorded with staleAt = now so the next reader sees it as stale (§4.1 #22).
      const failed = (outcome: EligibilityOutcome, reason: string): HetsEligibilityResult => ({
        ...base,
        outcome,
        reason,
        staleAt: checkedAt,
      });

      const provider = await deps.providers.providerForEligibility(
        input.organizationId,
        input.providerEntityId,
      );
      if (!provider) return failed("error", "provider_entity_not_found");

      let subscriber: EligibilitySubscriberIdentity | null = await deps
        .mbiUnlock()
        .unlockForEligibility({
          organizationId: input.organizationId,
          patientId: input.patientId,
          onDate: input.asOfServiceDate,
        });
      if (!subscriber) return failed("mbi_invalid", "mbi_not_on_file");

      let x12: string;
      try {
        x12 = build270({
          submitterId: deps.submitterId,
          provider,
          subscriber: {
            mbi: subscriber.mbi,
            lastName: subscriber.lastName,
            firstName: subscriber.firstName,
            dateOfBirth: subscriber.dateOfBirth || null,
          },
          serviceDates: { from: input.asOfServiceDate, to: input.asOfServiceDate },
          controlNumber: controlNumber(checkedAt),
          traceNumber,
          usage: deps.usage,
          now: checkedAt,
        });
      } catch {
        return failed("mbi_invalid", "subscriber_identity_invalid");
      }
      const mbi = subscriber.mbi;
      // Release the subscriber identity now that the 270 is built (§8.7 "zeroed after the 270 build").
      subscriber = null;

      let response: string;
      try {
        response = (await deps.transport.exchange({ x12, payloadId: traceNumber })).x12;
      } catch (err) {
        return failed(
          "error",
          err instanceof HetsTransportError ? err.code : "HETS_TRANSPORT_FAILED",
        );
      } finally {
        x12 = "";
      }

      let parsed: ReturnType<typeof parse271>;
      try {
        parsed = parse271(response, { asOfServiceDate: input.asOfServiceDate });
      } catch {
        return failed("indeterminate", "response_not_x12");
      }
      response = "";

      const history =
        parsed.transaction === "271" && parsed.rejections.length === 0
          ? deriveHospiceHistory(parsed.hospiceRecords, { asOfServiceDate: input.asOfServiceDate })
          : null;
      const covering = parsed.partA.entitlements.find(
        (e) =>
          (e.start === null || e.start <= input.asOfServiceDate) &&
          (e.end === null || e.end >= input.asOfServiceDate),
      );
      const entitlement = covering ?? parsed.partA.entitlements.at(-1) ?? null;
      const outcome = DOMAIN_OUTCOME[parsed.outcome];
      const resolved = outcome === "active_part_a" || outcome === "inactive_part_a";
      const result: HetsEligibilityResult = {
        ...base,
        outcome,
        reason: resolved ? null : `hets_${parsed.transaction}_${parsed.outcome}`,
        partAEffectiveDate: entitlement?.start ?? null,
        partATerminationDate: entitlement?.end ?? null,
        hospiceElectionOnFile: (history?.periods.length ?? 0) > 0,
        hospice: history,
        rejectionCodes: parsed.rejections.map((r) => `${r.loop}:${r.code}`),
        staleAt: resolved ? fresh : checkedAt,
      };
      // The persistence-boundary guard (§8.7): refuse to hand back anything carrying the MBI.
      assertNoMbi(result, mbi);
      return result;
    },
  };
}

// ── env configuration ─────────────────────────────────────────────────────────────────────────────────

export type M23HetsConfig =
  | {
      readonly transport: "core_mime";
      readonly endpointUrl: string;
      readonly submitterId: string;
      readonly bearerToken?: string;
      readonly clientCertificate?: { readonly certPem: string; readonly keyPem: string };
      readonly usage: "P" | "T";
      readonly timeoutMs: number;
    }
  | {
      readonly transport: "sandbox";
      readonly submitterId: string;
      readonly usage: "T";
      readonly scenario?: Hets271Scenario;
    };

/**
 * Read the HETS configuration. `null` = not configured → the port stays UNBOUND and eligibility checks keep
 * answering 503 (never a fabricated result). Throws on a present-but-invalid configuration so a typo fails
 * the boot loudly instead of silently disabling eligibility.
 */
export function m23HetsConfigFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): M23HetsConfig | null {
  const transport = env.M23_HETS_TRANSPORT?.trim().toLowerCase();
  if (!transport) return null;
  if (transport === "sandbox") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "M23_HETS_TRANSPORT=sandbox is refused in production (synthetic eligibility)",
      );
    }
    const scenario = env.M23_HETS_SANDBOX_SCENARIO?.trim();
    if (scenario && !HETS_271_SCENARIOS.includes(scenario as Hets271Scenario)) {
      throw new Error(`M23_HETS_SANDBOX_SCENARIO must be one of ${HETS_271_SCENARIOS.join(", ")}`);
    }
    return {
      transport: "sandbox",
      submitterId: env.M23_HETS_SUBMITTER_ID?.trim() || "SANDBOX",
      usage: "T",
      ...(scenario ? { scenario: scenario as Hets271Scenario } : {}),
    };
  }
  if (transport !== "core_mime") {
    throw new Error("M23_HETS_TRANSPORT must be `core_mime` or `sandbox` (or unset)");
  }
  const endpointUrl = env.M23_HETS_ENDPOINT_URL?.trim();
  const submitterId = env.M23_HETS_SUBMITTER_ID?.trim();
  if (!endpointUrl || !/^https:\/\//.test(endpointUrl)) {
    throw new Error("M23_HETS_ENDPOINT_URL must be an https:// URL");
  }
  if (!submitterId || !/^[A-Za-z0-9]{1,15}$/.test(submitterId)) {
    throw new Error("M23_HETS_SUBMITTER_ID must be the 1-15 character HETS Submitter ID");
  }
  const bearerToken = env.M23_HETS_AUTH_TOKEN?.trim() || undefined;
  const certFile = env.M23_HETS_CLIENT_CERT_FILE?.trim();
  const keyFile = env.M23_HETS_CLIENT_KEY_FILE?.trim();
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error("M23_HETS_CLIENT_CERT_FILE and M23_HETS_CLIENT_KEY_FILE must be set together");
  }
  if (!bearerToken && !certFile) {
    throw new Error(
      "M23_HETS_TRANSPORT=core_mime needs M23_HETS_AUTH_TOKEN (clearinghouse) or a client certificate (CMS)",
    );
  }
  const usage = (env.M23_HETS_USAGE?.trim().toUpperCase() || "P") as "P" | "T";
  if (usage !== "P" && usage !== "T") throw new Error("M23_HETS_USAGE must be P or T");
  const timeoutMs = Number(env.M23_HETS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new Error("M23_HETS_TIMEOUT_MS must be an integer from 1000 through 120000");
  }
  return {
    transport: "core_mime",
    endpointUrl,
    submitterId,
    ...(bearerToken ? { bearerToken } : {}),
    ...(certFile && keyFile
      ? { clientCertificate: { certPem: readFile(certFile), keyPem: readFile(keyFile) } }
      : {}),
    usage,
    timeoutMs,
  };
}

/** Build the transport a {@link M23HetsConfig} names. */
export function createM23HetsTransport(config: M23HetsConfig): HetsTransport {
  if (config.transport === "sandbox") {
    return createSandboxHetsTransport(config.scenario ? { scenario: config.scenario } : {});
  }
  return createCoreMimeHetsTransport({
    endpointUrl: config.endpointUrl,
    submitterId: config.submitterId,
    ...(config.bearerToken ? { bearerToken: config.bearerToken } : {}),
    ...(config.clientCertificate ? { clientCertificate: config.clientCertificate } : {}),
    timeoutMs: config.timeoutMs,
  });
}
