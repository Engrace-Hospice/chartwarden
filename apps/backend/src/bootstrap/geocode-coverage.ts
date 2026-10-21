// apps/backend/src/bootstrap/geocode-coverage.ts — GAP-054 rollout dependency made observable.
//
// M18 decides the capture geofence against the patient's geocoded service address. No geocoder is bound in
// this codebase yet (M5's `m5.geocode_address` processor has no vendor adapter and no consumer), so until
// coordinates are supplied every capture records `no_geofence_baseline`, no `at_patient_address` event fires
// and M17's EVV-driven advance goes quiet. This module turns that into a number: a Prometheus gauge and a
// boot-time log line, fed by an injected per-org count (M5 owns the query) and the platform active-org list.
//
// Pure over its ports (no DB, no Fastify) so it unit-tests with fakes. A failing org or an unreadable org
// list is reported as UNMEASURED, never as zero — a gap that cannot be measured must not look closed.
import { Gauge, type Registry } from "prom-client";

export interface GeocodeCoverageCount {
  readonly activePatients: number;
  readonly ungeocoded: number;
}

export interface GeocodeCoverageSample extends GeocodeCoverageCount {
  readonly orgsChecked: number;
  readonly orgsFailed: number;
}

export interface GeocodeCoveragePorts {
  readonly listOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly countForOrg: (organizationId: string) => Promise<GeocodeCoverageCount>;
}

export type GeocodeCoverageSampler = () => Promise<GeocodeCoverageSample | null>;

/** Sum the per-org counts; `null` when the org list cannot be read. */
export async function sampleGeocodeCoverage(
  ports: GeocodeCoveragePorts,
): Promise<GeocodeCoverageSample | null> {
  let orgs: readonly { readonly organizationId: string }[];
  try {
    orgs = await ports.listOrgs();
  } catch {
    return null;
  }
  const results = await Promise.all(
    orgs.map((o) =>
      ports.countForOrg(o.organizationId).then(
        (count) => count,
        () => null,
      ),
    ),
  );
  const measured = results.filter((r): r is GeocodeCoverageCount => r !== null);
  return {
    orgsChecked: measured.length,
    orgsFailed: results.length - measured.length,
    activePatients: measured.reduce((sum, r) => sum + r.activePatients, 0),
    ungeocoded: measured.reduce((sum, r) => sum + r.ungeocoded, 0),
  };
}

/** `chartwarden_patient_ungeocoded_active_total` — active patients with no service-address coordinate (-1 = not measured). */
export function registerGeocodeCoverageMetrics(
  registry: Registry,
  sampler: GeocodeCoverageSampler,
): void {
  new Gauge({
    name: "chartwarden_patient_ungeocoded_active_total",
    help: "Active patients whose current primary address has no geocode coordinate; each one's EVV captures record no_geofence_baseline (-1 = not measured)",
    registers: [registry],
    async collect() {
      let sample: GeocodeCoverageSample | null = null;
      try {
        sample = await sampler();
      } catch {
        sample = null;
      }
      // Any org that could not be counted makes the total a lower bound, so the whole reading is unmeasured.
      this.set(sample && sample.orgsFailed === 0 ? sample.ungeocoded : -1);
    },
  });
}

export interface GeocodeCoverageLog {
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly info: (fields: Record<string, unknown>, message: string) => void;
}

const GAP_MESSAGE =
  "GAP-054: active patients have no geocoded service-address coordinate — their EVV captures record " +
  "no_geofence_baseline (advisory), no at_patient_address event fires and M17's EVV-driven advance stays " +
  "quiet. Populate patient_address.geocode_lat/geocode_lng before relying on the geofence (runbook §16.7).";

/** Log the coverage at boot: warn on a gap or an unmeasurable state, info when fully geocoded. Never throws. */
export async function warnOnGeocodeCoverageGap(
  sampler: GeocodeCoverageSampler,
  log: GeocodeCoverageLog,
): Promise<void> {
  let sample: GeocodeCoverageSample | null = null;
  try {
    sample = await sampler();
  } catch {
    sample = null;
  }
  if (!sample || sample.orgsFailed > 0) {
    log.warn(
      { sample },
      "GAP-054: geocode coverage could not be measured (needs DATABASE_PLATFORM_URL and a readable patient_address); treat EVV geofence baselines as unverified",
    );
    return;
  }
  if (sample.ungeocoded > 0) {
    log.warn(
      {
        ungeocodedActivePatients: sample.ungeocoded,
        activePatients: sample.activePatients,
        orgsChecked: sample.orgsChecked,
      },
      GAP_MESSAGE,
    );
    return;
  }
  log.info(
    { activePatients: sample.activePatients, orgsChecked: sample.orgsChecked },
    "GAP-054: every active patient has a geocoded service address",
  );
}
