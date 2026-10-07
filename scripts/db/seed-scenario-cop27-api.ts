/**
 * WardenX — COP27 / FY2027 hospice demo data, written ONLY through the public HTTP API.
 *
 * Built to be run by a human against a deployed environment that holds demo data only (including
 * production while it has no real patients). Every write goes through the same routes the web app uses, so
 * permissions, ABAC, state machines, the outbox and the audit trail all apply; the script never touches the
 * database. It is additive and idempotent: each demo patient's legal last name is its marker
 * (`DEMO-COP27-NN`), every step first looks for its own effect, and nothing that existed before is modified
 * or deleted.
 *
 * Scenarios (dates relative to today in the service location's timezone):
 *   01 referral only (intake inbox)
 *   02 admission in intake, not activated — readiness shows the CTI signature and the 418.25(a) physician
 *      admission recommendation as still owed
 *   03 active, election effective 2026-07 (addendum not mandatory) — care plan, RN visits, comfort medication
 *   04 active, election ~5 days ago — addendum furnished + signed by the beneficiary, listing one drug and one
 *      supply request determined not covered (unrelated) and the unrelated care-plan condition
 *   05 active, election ~4 days ago — addendum drafted, NOT furnished: the 5-day initial window is due
 *   06 active, election ~3 days ago — addendum furnished and awaiting signature, then a drug coverage change
 *      opens version 2 and the 3-day update window
 *   07 active (ordinary activation today) — addendum refused, the refusal reason naming the representative
 *   08 recertification into benefit period 3: telehealth F2F with the 418.22(a)(4)(ii) eligibility answers,
 *      attested by narrative
 *   09 recertification into benefit period 4: in-person F2F, attested by narrative
 *   10 live discharge (no longer terminally ill) with the 418.26(b) physician discharge order
 *   11 for-cause discharge, then the physician cosign
 *   12 death discharge with place of death — the open addendum settles (no signature owed)
 *   13 revocation — the open addendum settles the same way
 *   org FY2027 rate table for the provider entity (HQRP-compliant CMS national rates, corrected 2026-09-30)
 *
 * What the platform allows through the API shapes the scenarios (each is also logged as a skip or note):
 *   · An activation always dates the election TODAY; past election dates (03-06, 08-09) come from transfer-ins
 *     (`priorElectionStartDate`), the only route that dates an election in the past.
 *   · Physician-only steps (CTI signature, F2F completion/attestation, prescribing) and every chart-level write
 *     need an account with `medical_director` / `hospice_physician`: the admin when it holds one, otherwise an
 *     EXISTING physician account passed in the environment. The admin alone covers 01, 02 (up to the drafted
 *     election statement) and the rate table; the rest are skipped with the reason.
 *   · Recertification CTIs are left drafted: M6 starts the next period at the signature, dated that day.
 *   · Signing a visit note (to attest an F2F by note) needs a fresh MFA step-up, which this script cannot do.
 *   · Nothing is ever created with a known password: the script signs in only to accounts that already exist.
 *
 * Usage (password only from the environment — never argv, never logged):
 *   WARDENX_SEED_BASE_URL=https://host WARDENX_SEED_ADMIN_PASSWORD=… bun run db:seed:scenario-cop27-api
 *   … -- --apply                                   # write (default is a dry run)
 *   … -- --apply --i-understand-this-is-production # required too when the host is not localhost
 * Optional env: WARDENX_SEED_ADMIN_EMAIL (default admin@wardenx.local), WARDENX_SEED_ORG_ID,
 * WARDENX_SEED_PROVIDER_ENTITY_ID, WARDENX_SEED_PHYSICIAN_EMAIL + WARDENX_SEED_PHYSICIAN_PASSWORD (an EXISTING
 * account holding medical_director / hospice_physician, used only for physician signatures).
 */
import { type SeedContext, describeContext, discoverContext } from "./cop27/context";
import { seedCalendar } from "./cop27/dates";
import { type Session, signIn } from "./cop27/http";
import { RunReport } from "./cop27/report";
import { SCENARIOS } from "./cop27/scenarios";

interface Options {
  readonly apply: boolean;
  readonly productionAck: boolean;
  readonly only: readonly string[] | null;
}

function parseArgs(rawArgv: readonly string[]): Options {
  // `bun run <script> -- --apply` may forward the separator itself.
  const argv = rawArgv.filter((a) => a !== "--");
  const known = new Set(["--dry-run", "--apply", "--i-understand-this-is-production"]);
  let only: string[] | null = null;
  for (const a of argv) {
    if (a.startsWith("--only=")) {
      only = a.slice("--only=".length).split(",").filter(Boolean);
      continue;
    }
    if (!known.has(a)) throw new Error(`unknown argument '${a}'`);
  }
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  return {
    apply: argv.includes("--apply"),
    productionAck: argv.includes("--i-understand-this-is-production"),
    only,
  };
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function isLocalHost(baseUrl: URL): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(baseUrl.hostname);
}

async function optionalPhysicianSession(baseUrl: string, orgId?: string): Promise<Session | null> {
  const email = process.env.WARDENX_SEED_PHYSICIAN_EMAIL?.trim();
  const password = process.env.WARDENX_SEED_PHYSICIAN_PASSWORD;
  if (!email || !password) return null;
  return signIn({ baseUrl, email, password, ...(orgId ? { organizationId: orgId } : {}) });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrlText = requireEnv("WARDENX_SEED_BASE_URL").replace(/\/+$/, "");
  const baseUrl = new URL(baseUrlText);
  const email = process.env.WARDENX_SEED_ADMIN_EMAIL?.trim() || "admin@wardenx.local";
  const password = requireEnv("WARDENX_SEED_ADMIN_PASSWORD");
  const orgId = process.env.WARDENX_SEED_ORG_ID?.trim() || undefined;
  const local = isLocalHost(baseUrl);

  if (opts.apply && !local && !opts.productionAck) {
    throw new Error(
      `${baseUrl.host} is not localhost: writing to it needs --apply --i-understand-this-is-production`,
    );
  }
  console.log(
    `COP27 demo seed → ${baseUrl.origin} — ${opts.apply ? "APPLY (writes enabled)" : "DRY RUN (no writes; pass --apply to write)"}`,
  );

  const admin = await signIn({
    baseUrl: baseUrlText,
    email,
    password,
    ...(orgId ? { organizationId: orgId } : {}),
  });
  const physicianSession = await optionalPhysicianSession(baseUrlText, admin.organizationId);
  const ctx: SeedContext = await discoverContext({
    admin,
    physicianSession,
    ...(process.env.WARDENX_SEED_PROVIDER_ENTITY_ID
      ? { providerEntityId: process.env.WARDENX_SEED_PROVIDER_ENTITY_ID }
      : {}),
  });
  const cal = seedCalendar(ctx.location?.timezone ?? "America/New_York");
  for (const line of describeContext(ctx)) console.log(`  ${line}`);
  console.log(`  today (${cal.timeZone}): ${cal.today}\n`);

  const report = new RunReport();
  for (const scenario of SCENARIOS) {
    if (opts.only && !opts.only.includes(scenario.key)) continue;
    console.log(`\n── ${scenario.key} ${scenario.title}`);
    await scenario.run({ ctx, cal, report, apply: opts.apply });
  }
  report.printSummary();

  const failed = report.failedScenarios();
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  } else if (!opts.apply) {
    console.log("\nDry run complete — nothing was written. Re-run with --apply to write.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
