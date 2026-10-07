/**
 * COP27 API seed — the per-scenario step runner.
 *
 * Every step is "find, else create": the find half is a read that recognizes the step's effect already being
 * present (so a re-run records `exists` and writes nothing); the create half is the write, run only with
 * `--apply`. In a dry run the first missing step is recorded as `plan` and the scenario stops there — later
 * steps depend on ids the write would have produced.
 *
 * A failed or skipped CORE step ends its scenario (later steps depend on it). A SOFT step (care plan, visits,
 * the optional extras) records its outcome and lets the scenario continue.
 */
import { SkipStep } from "./http";
import type { RunReport } from "./report";

/** Ends a scenario whose stopping step has already been recorded (plan / skip / fail). */
class StopScenario extends Error {}

export class ScenarioRun {
  constructor(
    private readonly report: RunReport,
    readonly scenario: string,
    readonly apply: boolean,
  ) {}

  /** A core step: present → `exists`; dry run → `plan` + stop; else create → `ok`. Any error stops. */
  async ensure<T>(
    step: string,
    find: () => Promise<T | null>,
    create: () => Promise<T>,
    describe: (value: T) => string = () => "",
  ): Promise<T> {
    let value: T;
    try {
      const found = await find();
      if (found !== null) {
        this.report.record(this.scenario, step, "exists", describe(found));
        return found;
      }
      if (!this.apply) {
        this.report.record(this.scenario, step, "plan", "would be written with --apply");
        throw new StopScenario();
      }
      value = await create();
    } catch (err) {
      if (!(err instanceof StopScenario)) this.report.recordError(this.scenario, step, err);
      throw new StopScenario();
    }
    this.report.record(this.scenario, step, "ok", describe(value));
    return value;
  }

  /** A soft step: like {@link ensure}, but after its outcome is recorded the scenario continues. */
  async soft<T>(
    step: string,
    find: () => Promise<T | null>,
    create: () => Promise<T>,
    describe: (value: T) => string = () => "",
  ): Promise<T | null> {
    try {
      return await this.ensure(step, find, create, describe);
    } catch (err) {
      if (err instanceof StopScenario) return null;
      throw err;
    }
  }

  /** Record a deliberate choice (not a skip: nothing is missing); the scenario continues. */
  note(step: string, detail: string): void {
    this.report.record(this.scenario, step, "note", detail);
  }

  /** Record a step that is deliberately not attempted; the scenario continues. */
  skip(step: string, reason: string): void {
    this.report.record(this.scenario, step, "skip", reason);
  }

  /** Record a skip for `step` and end the scenario (a precondition the org does not have). */
  stop(step: string, reason: string): never {
    this.report.record(this.scenario, step, "skip", reason);
    throw new StopScenario();
  }
}

/** Run one scenario body; anything that escapes a step is recorded once against the scenario. */
export async function runScenario(
  report: RunReport,
  scenario: string,
  apply: boolean,
  body: (run: ScenarioRun) => Promise<void>,
): Promise<void> {
  const run = new ScenarioRun(report, scenario, apply);
  try {
    await body(run);
  } catch (err) {
    if (err instanceof StopScenario) return;
    report.recordError(scenario, "scenario", err);
  }
}

export { SkipStep };
