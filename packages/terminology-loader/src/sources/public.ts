import {
  type FetchContext,
  type FetchedSource,
  type PublicSourceAdapter,
  fetchBytes,
  isoDay,
} from "./adapter";
// @chartwarden/terminology-loader — tier-1 PUBLIC adapters, gated by the egress flag (`TERMINOLOGY_LOADER_EGRESS=on`).
//
// What exists, and what does not:
//   icd10cm  CDC/NCHS FTP — fetches the Code Descriptions zip for the target fiscal year. NCHS names that file
//            inconsistently across years (`icd10cm-Code Descriptions-2026.zip` vs `icd10cm-code-descriptions-2027.zip`),
//            so both spellings are tried. The Tabular List zip is NOT fetched (chapter / note flags stay empty
//            on an auto-fetched load; an operator upload of both files restores them).
//   ndc      FDA `ndctext.zip` (updated daily; the version label is the fetch date, an unchanged file is skipped).
//   cvx      CDC `cvx.txt`.
//   revenue  a bundled hospice subset (./revenue-static) — the full NUBC list is an admin upload.
// NOT adapted (no stable machine-readable URL): hcpcs, icd10pcs, carc, rarc — admin upload is their only path.
// ⚠ None of these URLs has been exercised from CI (no egress); they are constants an operator should confirm.
import { revenueStaticSeedBytes } from "./revenue-static";

const NCHS = "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM";
const NDC_URL = "https://www.accessdata.fda.gov/cder/ndctext.zip";
const CVX_URL = "https://www2a.cdc.gov/vaccines/iis/iisstandards/downloads/cvx.txt";
const STATIC_REVENUE_VERSION = "hospice-subset-2026-10";

/** The federal fiscal year a run targets: Sep–Dec runs target the NEXT October's release. */
export function icd10cmFiscalYear(now: Date, mode: FetchContext["mode"]): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (mode === "dry_run") return month >= 9 ? year + 1 : year;
  return month >= 10 ? year + 1 : year;
}

/** CMS/NCHS file-name spellings for a fiscal year's Code Descriptions zip. */
export function icd10cmCandidateUrls(fy: number): string[] {
  return [
    `${NCHS}/${fy}/icd10cm-code-descriptions-${fy}.zip`,
    `${NCHS}/${fy}/icd10cm-Code%20Descriptions-${fy}.zip`,
  ];
}

const icd10cm: PublicSourceAdapter = {
  system: "icd10cm",
  egress: true,
  async fetchLatest(ctx) {
    const fy = icd10cmFiscalYear(ctx.now, ctx.mode);
    for (const url of icd10cmCandidateUrls(fy)) {
      const bytes = await fetchBytes(url, ctx);
      if (bytes) {
        return {
          version: `FY${fy}`,
          releasedOn: isoDay(ctx.now),
          effectiveFrom: `${fy - 1}-10-01`,
          bytes,
          origin: url,
        } satisfies FetchedSource;
      }
    }
    return null;
  },
};

function dailyAdapter(system: "ndc" | "cvx", url: string): PublicSourceAdapter {
  return {
    system,
    egress: true,
    async fetchLatest(ctx) {
      const bytes = await fetchBytes(url, ctx);
      if (!bytes) return null;
      const day = isoDay(ctx.now);
      return { version: day, releasedOn: day, effectiveFrom: day, bytes, origin: url };
    },
  };
}

const revenue: PublicSourceAdapter = {
  system: "revenue",
  egress: false,
  async fetchLatest(ctx) {
    const day = isoDay(ctx.now);
    return {
      version: STATIC_REVENUE_VERSION,
      releasedOn: "2026-10-01",
      effectiveFrom: "2026-10-01",
      bytes: revenueStaticSeedBytes(),
      origin: `bundled:${STATIC_REVENUE_VERSION}@${day}`,
    };
  },
};

/** The public adapters by system. */
export const PUBLIC_SOURCE_ADAPTERS: Readonly<
  Partial<Record<PublicSourceAdapter["system"], PublicSourceAdapter>>
> = {
  icd10cm,
  ndc: dailyAdapter("ndc", NDC_URL),
  cvx: dailyAdapter("cvx", CVX_URL),
  revenue,
};
