/**
 * Pure rendering for the coordinated backup drill and the restore verifier (#857). No IO.
 */
import type { Check } from "../restore-drill/report";

export function renderChecks(checks: readonly Check[]): string {
  return [
    "| result | check | detail |",
    "|---|---|---|",
    ...checks.map(
      (c) => `| ${c.ok ? "PASS" : "FAIL"} | ${c.name} | ${c.detail.replaceAll("|", "/")} |`,
    ),
  ].join("\n");
}

export interface CoordinatedDrillRecord {
  readonly runId: string;
  readonly startedAt: string;
  readonly scale: string;
  readonly tooling: Readonly<Record<string, string>>;
  readonly snapshots: ReadonlyArray<{
    readonly id: string;
    readonly baseBackup: string;
    readonly lsn: string;
    readonly objects: number;
    readonly bytes: number;
    readonly wallMs: number;
  }>;
  readonly rto: {
    readonly restoreWallMs: number;
    readonly phasesMs: Readonly<Record<string, number>>;
    readonly verifyWallMs: number;
  };
  readonly rpo: {
    readonly snapshotAt: string;
    readonly failureAt: string;
    readonly windowMs: number;
    readonly rowsLost: Readonly<Record<string, number>>;
    readonly objectsLost: number;
  };
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function renderDrillMarkdown(r: CoordinatedDrillRecord): string {
  const lost = Object.entries(r.rpo.rowsLost).filter(([, n]) => n > 0);
  const lostRows = lost.map(([t, n]) => `${n} ${t}`).join(", ") || "no rows";
  return [
    `# Coordinated backup -> restore -> verify drill - ${r.passed ? "PASS" : "FAIL"}`,
    "",
    "> **Synthetic scale, private containers on one developer machine.** These numbers prove the mechanism and the",
    "> verifier end to end; they do not size production. Production RPO/RTO must come from a witnessed drill on the",
    "> real host and off-site target (see the follow-up ops issue).",
    "",
    `Run ${r.runId} at ${r.startedAt}. Scale: ${r.scale}.`,
    "",
    "## Tooling",
    ...Object.entries(r.tooling).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "## Snapshots taken",
    "| snapshot | base backup | LSN | objects | bytes | wall |",
    "|---|---|---|---|---|---|",
    ...r.snapshots.map(
      (s) =>
        `| ${s.id} | ${s.baseBackup} | ${s.lsn} | ${s.objects} | ${s.bytes} | ${secs(s.wallMs)} |`,
    ),
    "",
    "## Measured RTO (synthetic scale)",
    `Isolated restore (pgBackRest restore + WAL replay + promotion + object copy with sha256 check): **${secs(r.rto.restoreWallMs)}**. Verification: ${secs(r.rto.verifyWallMs)}.`,
    "",
    "| phase | wall |",
    "|---|---|",
    ...Object.entries(r.rto.phasesMs).map(([k, v]) => `| ${k} | ${secs(v)} |`),
    "",
    "## Measured RPO (synthetic scale)",
    `Restored snapshot taken ${r.rpo.snapshotAt}; source destroyed ${r.rpo.failureAt}. Window lost: **${secs(r.rpo.windowMs)}** (${lostRows}; ${r.rpo.objectsLost} object(s)). With the production schedule the coordinated RPO is the snapshot interval (default 15 min); the database alone can be recovered to the last archived WAL segment (archive_timeout 60 s).`,
    "",
    "## Checks",
    renderChecks(r.checks),
    "",
  ].join("\n");
}
