import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// .github/workflows/restore-drill.yml (CW-CP-01) is the only thing that makes the drills and the overdue alarm run, and
// a workflow GitHub rejects does not fail: its schedule simply never fires. So the mistakes that make a workflow
// invalid or silently inert are pinned here: a context a job-level key cannot use, a cron that drifted from the `if` that
// selects its job, a trigger that would let it reach release/deploy, and a secret spliced into a shell line.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEXT = readFileSync(join(REPO, ".github/workflows/restore-drill.yml"), "utf8");

interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, string>>;
}
interface Job {
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly "timeout-minutes"?: number;
  readonly steps: readonly Step[];
}
interface Workflow {
  readonly on: {
    readonly schedule?: ReadonlyArray<{ readonly cron: string }>;
    readonly workflow_dispatch?: {
      readonly inputs?: Record<string, { readonly options?: readonly string[] }>;
    };
    readonly [trigger: string]: unknown;
  };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, Job>>;
}
const wf = yaml.load(TEXT) as Workflow;
const crons = (wf.on.schedule ?? []).map((s) => s.cron);
const cronsIn = (condition: string | undefined): string[] =>
  [...(condition ?? "").matchAll(/github\.event\.schedule == '([^']+)'/g)].map((m) => m[1] ?? "");
const expressions = (text: string): string[] =>
  [...text.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => (m[1] ?? "").trim());

describe("restore-drill.yml", () => {
  it("can only be started by its schedules or by hand, never from another workflow or a push", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(crons).toHaveLength(2);
  });

  it("selects each job by exactly one cron literal that exists in on.schedule", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      const used = cronsIn(job.if);
      expect(used, `${name} is selected by one cron`).toHaveLength(1);
      expect(crons, `${name}'s cron is scheduled`).toContain(used[0]);
    }
    const all = Object.values(wf.jobs).flatMap((j) => cronsIn(j.if));
    expect([...all].sort()).toEqual([...crons].sort());
  });

  it("offers by hand exactly the jobs it has, and every job honours its option", () => {
    const options = wf.on.workflow_dispatch?.inputs?.job?.options ?? [];
    expect([...options].sort()).toEqual(Object.keys(wf.jobs).sort());
    for (const name of Object.keys(wf.jobs)) {
      expect(wf.jobs[name]?.if, name).toContain(`inputs.job == '${name}'`);
    }
  });

  it("runs a manual dispatch only from main (a branch's copy must never receive the webhook secret)", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job.if, name).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it("uses no context a job-level key does not have (an invalid workflow never fires)", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const [key, value] of Object.entries(job.env ?? {})) {
        for (const expr of expressions(String(value))) {
          expect(expr, `${name}.env.${key}`).not.toMatch(/\b(runner|steps|env|job)\./);
        }
      }
      for (const expr of expressions(job.if ?? "")) {
        expect(expr, `${name}.if`).not.toMatch(/\b(secrets|runner|steps|env|job)\./);
      }
    }
  });

  it("never splices a secret or an input into a shell line (they reach `run` through env)", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps) {
        if (!step.run) continue;
        expect(step.run, `${name}: ${step.id ?? step.run.slice(0, 40)}`).not.toMatch(
          /\$\{\{\s*(secrets|inputs|github\.event\.inputs|steps\.[^}]*outputs)/,
        );
      }
    }
  });

  it("is read-only and bounded, and the drills run on the shared runner without a matrix", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job["timeout-minutes"], `${name} is bounded`).toBeGreaterThan(0);
    }
    expect(TEXT).not.toMatch(/^\s*matrix:/m);
  });

  it("pages for a failed OR cancelled drill and still fails the job", () => {
    const page = wf.jobs.drill?.steps.find((s) =>
      (s.run ?? "").includes("backup.scheduled_drill_failed"),
    );
    expect(page?.if).toMatch(/always\(\)/);
    expect(page?.if).toMatch(/cancelled\(\)/);
    // an install or checkout failure is not shielded by continue-on-error: it must page too
    expect(page?.if).toMatch(/failure\(\)/);
    expect(page?.run).toMatch(/exit 1\s*$/);
    expect(page?.run).toContain("--proto =https");
    expect(page?.run).not.toMatch(/curl[^\n]*\$OPS_ALERT_WEBHOOK_URL/); // the bearer URL goes in via stdin, not argv
  });

  it("keeps the overdue check install-free (it reads only audit/restore-drill)", () => {
    const steps = wf.jobs.overdue?.steps.map((s) => s.run ?? "") ?? [];
    expect(steps.join("\n")).not.toContain("bun install");
    expect(steps.join("\n")).toContain("bun run backup:drill-overdue");
  });
});
