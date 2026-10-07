/**
 * WardenX — bring Rosa Delgado's plan of care to "sent for physician review", written ONLY through the public
 * HTTP API.
 *
 * Production's Delgado has an empty draft v1 (the admission's bootstrap); the signed plan a local stack shows
 * comes from `seed-scenario-idg-packets.ts`, which forges the MFA step-up in the database and is NOT for
 * production. This script does every step that needs no step-up, through the same routes the web app uses,
 * and leaves the plan `in_review`:
 *   1. the terminal problem (I50.9) on the open draft
 *   2. a goal and an RN intervention on that problem
 *   3. finalize — "Send for physician review" in the app
 * The two signatures (RN case manager, hospice physician) need a fresh MFA step-up, which a password-only
 * script cannot perform: the signers open the patient's Care Plan → Review & Sign and sign there.
 *
 * Unlike the COP27 seed this one WRITES TO A PATIENT IT DID NOT CREATE — that is its purpose. It is still
 * additive and idempotent: every step first looks for its own effect, nothing is edited or deleted, and a plan
 * that already has a signed version is left alone.
 *
 * Usage (password only from the environment — never argv, never logged):
 *   WARDENX_SEED_BASE_URL=https://host WARDENX_SEED_ADMIN_PASSWORD=… bun run db:seed:scenario-delgado-care-plan-api
 *   … -- --apply                                   # write (default is a dry run)
 *   … -- --apply --i-understand-this-is-production # required too when the host is not localhost
 * Optional env: WARDENX_SEED_ADMIN_EMAIL (default admin@wardenx.local), WARDENX_SEED_ORG_ID,
 * WARDENX_SEED_PHYSICIAN_EMAIL + WARDENX_SEED_PHYSICIAN_PASSWORD (tried when the admin cannot reach the chart).
 */
import type { SeedContext } from "./cop27/context";
import { discoverContext } from "./cop27/context";
import { SkipStep, asAnyone, readAsAnyone, signIn } from "./cop27/http";
import { RunReport } from "./cop27/report";
import { type ScenarioRun, runScenario } from "./cop27/run";

const SCENARIO = "delgado-care-plan";
const FIRST_NAME = "Rosa";
const LAST_NAME = "Delgado";

const TERMINAL_PROBLEM = {
  icd10Code: "I50.9",
  description: "Advanced illness with progressive functional decline and symptom burden.",
  kind: "terminal",
  source: "clinical",
} as const;
const GOAL = {
  originalText: "Patient will report comfort at or below 3/10 on a 0-10 scale.",
  source: "clinical",
  measurableOutcome: "Symptom score <=3/10 on routine assessment.",
} as const;
const INTERVENTION = {
  scopeText: "RN case management visits to assess symptoms and coordinate the IDG plan of care.",
  frequencyText: "Twice weekly",
  frequencyValue: "2x/week",
  discipline: "rn",
} as const;

interface PlanVersion {
  id: string;
  status: string;
  version: number;
}
interface PlanView {
  id: string;
  versions: PlanVersion[];
  problems: Array<{ id: string; kind: string; status: string; icd10Code: string | null }>;
  goals: Array<{ id: string; problemId: string }>;
  interventions: Array<{ id: string; problemId: string }>;
}

function parseArgs(rawArgv: readonly string[]): { apply: boolean; productionAck: boolean } {
  const argv = rawArgv.filter((a) => a !== "--");
  const known = new Set(["--dry-run", "--apply", "--i-understand-this-is-production"]);
  for (const a of argv) if (!known.has(a)) throw new Error(`unknown argument '${a}'`);
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  return {
    apply: argv.includes("--apply"),
    productionAck: argv.includes("--i-understand-this-is-production"),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const isLocalHost = (url: URL): boolean =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);

async function findPatientId(ctx: SeedContext): Promise<string | null> {
  const page = await readAsAnyone<{
    items: Array<{ id: string; firstName: string; lastName: string }>;
  }>("search patients", ctx.sessions, (s) =>
    s.client.GET("/api/v1/patients", { params: { query: { q: LAST_NAME, limit: 20 } } }),
  );
  const hits = (page?.items ?? []).filter(
    (p) => p.lastName === LAST_NAME && p.firstName === FIRST_NAME,
  );
  if (hits.length > 1) {
    throw new Error(`${hits.length} patients named ${FIRST_NAME} ${LAST_NAME}; refusing to guess`);
  }
  return hits[0]?.id ?? null;
}

async function readPlan(ctx: SeedContext, patientId: string): Promise<PlanView | null> {
  type Raw = Partial<PlanView> & { carePlan?: Partial<PlanView> | null };
  const raw = await readAsAnyone<Raw>("read care plan", ctx.sessions, (s) =>
    s.client.GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } }),
  );
  const plan = raw && "carePlan" in raw ? raw.carePlan : raw;
  if (!plan?.id) return null;
  return {
    id: plan.id,
    versions: plan.versions ?? [],
    problems: plan.problems ?? [],
    goals: plan.goals ?? [],
    interventions: plan.interventions ?? [],
  };
}

const activeTerminal = (plan: PlanView): PlanView["problems"][number] | null =>
  plan.problems.find((p) => p.kind === "terminal" && p.status === "active") ?? null;

async function seedDelgado(run: ScenarioRun, ctx: SeedContext): Promise<void> {
  // Lookups, not steps: this script never creates the patient or the plan.
  const patientId = await findPatientId(ctx);
  if (!patientId) run.stop("patient", `no patient named ${FIRST_NAME} ${LAST_NAME} is reachable`);
  const plan = await readPlan(ctx, patientId);
  if (!plan) {
    run.stop("care plan", "no care plan — the admission must be active (activation opens it)");
  }
  run.note("care plan", `patient ${patientId}, plan ${plan.id}`);
  if (plan.versions.some((v) => v.status === "signed")) {
    run.note("care plan", "already has a signed version — left alone");
    return;
  }
  const reread = async (): Promise<PlanView> => {
    const p = await readPlan(ctx, patientId);
    if (!p) throw new Error("care plan no longer readable");
    return p;
  };

  const terminal = await run.ensure(
    "terminal problem (I50.9)",
    async () => activeTerminal(plan),
    async () => {
      await asAnyone("add terminal problem", ctx.sessions, (s) =>
        s.client.POST("/api/v1/care-plans/{planId}/problems", {
          params: { path: { planId: plan.id } },
          body: TERMINAL_PROBLEM,
        }),
      );
      const p = activeTerminal(await reread());
      if (!p) throw new Error("terminal problem not on the plan after create");
      return p;
    },
    (p) => `problem ${p.id}${p.icd10Code ? ` ${p.icd10Code}` : ""}`,
  );

  await run.ensure(
    "goal",
    async () => (await reread()).goals.find((g) => g.problemId === terminal.id) ?? null,
    async () =>
      asAnyone<{ id: string }>("add goal", ctx.sessions, (s) =>
        s.client.POST("/api/v1/care-plans/{planId}/goals", {
          params: { path: { planId: plan.id } },
          body: { problemId: terminal.id, ...GOAL },
        }),
      ),
    (g) => `goal ${g.id}`,
  );
  await run.ensure(
    "RN intervention",
    async () => (await reread()).interventions.find((i) => i.problemId === terminal.id) ?? null,
    async () =>
      asAnyone<{ id: string }>("add intervention", ctx.sessions, (s) =>
        s.client.POST("/api/v1/care-plans/{planId}/interventions", {
          params: { path: { planId: plan.id } },
          body: { problemId: terminal.id, ...INTERVENTION },
        }),
      ),
    (i) => `intervention ${i.id}`,
  );

  await run.ensure(
    "send for physician review (finalize)",
    async () => (await reread()).versions.find((v) => v.status === "in_review") ?? null,
    async () => {
      const draft = (await reread()).versions.find((v) => v.status === "draft");
      if (!draft) throw new SkipStep("no draft version to finalize");
      await asAnyone("finalize", ctx.sessions, (s) =>
        s.client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/finalize", {
          params: { path: { planId: plan.id, versionId: draft.id } },
          body: { ifVersion: draft.version },
        }),
      );
      return draft;
    },
    (v) => `version ${v.id}`,
  );
  run.note(
    "signatures",
    "RN case manager + hospice physician sign in the app (Care Plan → Review & Sign): each needs a fresh MFA step-up, which this script cannot perform",
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrlText = requireEnv("WARDENX_SEED_BASE_URL").replace(/\/+$/, "");
  const baseUrl = new URL(baseUrlText);
  const password = requireEnv("WARDENX_SEED_ADMIN_PASSWORD");
  const email = process.env.WARDENX_SEED_ADMIN_EMAIL?.trim() || "admin@wardenx.local";
  const orgId = process.env.WARDENX_SEED_ORG_ID?.trim() || undefined;
  if (opts.apply && !isLocalHost(baseUrl) && !opts.productionAck) {
    throw new Error(
      `${baseUrl.host} is not localhost: writing to it needs --apply --i-understand-this-is-production`,
    );
  }
  console.log(
    `Delgado care-plan seed → ${baseUrl.origin} — ${opts.apply ? "APPLY (writes enabled)" : "DRY RUN (no writes; pass --apply to write)"}`,
  );

  const admin = await signIn({
    baseUrl: baseUrlText,
    email,
    password,
    ...(orgId ? { organizationId: orgId } : {}),
  });
  const physicianEmail = process.env.WARDENX_SEED_PHYSICIAN_EMAIL?.trim();
  const physicianPassword = process.env.WARDENX_SEED_PHYSICIAN_PASSWORD;
  const physicianSession =
    physicianEmail && physicianPassword
      ? await signIn({
          baseUrl: baseUrlText,
          email: physicianEmail,
          password: physicianPassword,
          organizationId: admin.organizationId,
        })
      : null;
  const ctx = await discoverContext({ admin, physicianSession });

  const report = new RunReport();
  await runScenario(report, SCENARIO, opts.apply, (run) => seedDelgado(run, ctx));
  report.printSummary();
  if (report.failedScenarios().length > 0) process.exitCode = 1;
  else if (!opts.apply)
    console.log("\nDry run complete — nothing was written. Re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
