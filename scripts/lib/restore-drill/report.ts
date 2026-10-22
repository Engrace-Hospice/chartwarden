/**
 * Pure pieces of the M36 restore drill: comparison of the backup-time manifest against the restored state, and the
 * JSON / markdown report. No IO here, so scripts/__tests__/restore-drill-report.test.ts can pin every verdict.
 */

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What one stored object looked like when the backup was taken (and what the restored copy must match). */
export interface ObjectFingerprint {
  readonly size: number;
  readonly sha256: string;
  readonly etag: string | null;
}

/** The attachment rows the restored database claims, with the facts the object must satisfy. */
export interface AttachmentExpectation {
  readonly id: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly completed: boolean;
  readonly destroyed: boolean;
}

export interface RestoredObjects {
  /** `bucket/key` -> what a GET of the restored object returned; absent => the store answered 404. */
  readonly fingerprints: ReadonlyMap<string, ObjectFingerprint>;
  /** Every `bucket/key` physically present in the restored store. */
  readonly stored: ReadonlySet<string>;
}

export const objectId = (bucket: string, objectKey: string): string => `${bucket}/${objectKey}`;

export function compareCounts(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
): Check {
  const diffs = Object.keys(expected)
    .filter((table) => expected[table] !== actual[table])
    .map(
      (table) => `${table}: backup ${expected[table]} != restored ${actual[table] ?? "missing"}`,
    );
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  return {
    name: "row counts per M36 table equal the backup-time counts",
    ok: diffs.length === 0,
    detail:
      diffs.length === 0
        ? `${Object.keys(expected).length} tables, ${total} rows, all equal`
        : diffs.join("; "),
  };
}

/** Object-store consistency: bytes, size, etag, destroyed-absent, no orphans. Each problem is named. */
export function compareObjects(
  rows: readonly AttachmentExpectation[],
  backupManifest: ReadonlyMap<string, ObjectFingerprint>,
  restored: RestoredObjects,
): Check[] {
  const problems: string[] = [];
  const destroyedPresent: string[] = [];
  let verified = 0;
  for (const row of rows) {
    const id = objectId(row.bucket, row.objectKey);
    const got = restored.fingerprints.get(id);
    if (row.destroyed) {
      if (got) destroyedPresent.push(id);
      continue;
    }
    if (!row.completed) continue; // authorized but never uploaded: no object is owed
    if (!got) {
      problems.push(`${id}: object MISSING in restored store`);
      continue;
    }
    if (got.size !== row.byteSize) problems.push(`${id}: size ${got.size} != row ${row.byteSize}`);
    if (got.sha256 !== row.sha256Hex)
      problems.push(`${id}: sha256 differs from the row's sha256_hex`);
    const backedUp = backupManifest.get(id);
    if (backedUp && backedUp.etag !== null && got.etag !== backedUp.etag) {
      problems.push(`${id}: etag ${got.etag} != backup ${backedUp.etag}`);
    }
    if (!(backedUp && backedUp.sha256 === got.sha256 && backedUp.size === got.size)) {
      problems.push(`${id}: not byte-identical to the backup-time object`);
    }
    verified += 1;
  }
  const referenced = new Set(rows.map((r) => objectId(r.bucket, r.objectKey)));
  const orphans = [...restored.stored].filter((id) => !referenced.has(id));
  return [
    {
      name: "every non-destroyed attachment row has its object present and byte-identical (size, sha256, etag)",
      ok: problems.length === 0,
      detail: problems.length === 0 ? `${verified} objects verified` : problems.join("; "),
    },
    {
      name: "destroyed attachment rows have no object",
      ok: destroyedPresent.length === 0,
      detail:
        destroyedPresent.length === 0
          ? "none present"
          : `still present: ${destroyedPresent.join(", ")}`,
    },
    {
      name: "no orphan objects (every stored object is referenced by a row)",
      ok: orphans.length === 0,
      detail: orphans.length === 0 ? "none" : `orphans: ${orphans.join(", ")}`,
    },
  ];
}

/** Ids from the intrinsic message <-> attachment <-> audit reconcile over the restored DB. */
export interface ReconcileFindings {
  readonly messagesWithoutAudit: readonly string[];
  readonly revisionsWithoutAudit: readonly string[];
  readonly attachmentsWithoutAudit: readonly string[];
  readonly attachmentsWithoutMessage: readonly string[];
  readonly attachmentsCrossOrg: readonly string[];
  readonly orphanAudit: readonly string[];
}

const SAMPLE = 3;
const show = (ids: readonly string[]): string =>
  `${ids.length} (${ids.slice(0, SAMPLE).join(", ")}${ids.length > SAMPLE ? ", ..." : ""})`;

/** Reconcile verdict, independent of the backup manifest: the restored DB must agree with itself. */
export function reconcileCheck(f: ReconcileFindings): Check {
  const problems = (
    [
      ["messages with no message.insert audit event", f.messagesWithoutAudit],
      ["message_revisions with no audit event", f.revisionsWithoutAudit],
      ["attachments with no message_attachment.insert audit event", f.attachmentsWithoutAudit],
      ["attachments whose message row is missing", f.attachmentsWithoutMessage],
      ["attachments in a different org than their message", f.attachmentsCrossOrg],
      ["orphan audit events (message/attachment/revision id with no row)", f.orphanAudit],
    ] as const
  ).filter(([, ids]) => ids.length > 0);
  return {
    name: "message <-> attachment <-> audit reconcile (restored DB agrees with itself)",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? "every message, revision and attachment has its audit event; no orphan audit; attachments belong to a message in the same org"
        : problems.map(([label, ids]) => `${label}: ${show(ids)}`).join("; "),
  };
}

/** The documented RTO target is a TARGET (DR/BCP section 3), not a built service level; this only compares a measurement. */
export function rtoCheck(restoreWallMs: number, targetMs: number): Check {
  return {
    name: "restore wall time within the documented RTO target (demo scale)",
    ok: restoreWallMs <= targetMs,
    detail: `${(restoreWallMs / 1000).toFixed(1)} s measured vs ${(targetMs / 1000).toFixed(0)} s target`,
  };
}

export interface DrillReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly scale: string;
  readonly fault: string;
  readonly backupMethod: Readonly<Record<string, string>>;
  readonly rto: {
    readonly restoreWallMs: number;
    readonly phasesMs: Readonly<Record<string, number>>;
    readonly verifyWallMs: number;
  };
  readonly rpo: {
    readonly backupAt: string;
    readonly failureAt: string;
    readonly dataWindowLostMs: number;
    readonly rowsLostPerTable: Readonly<Record<string, number>>;
    readonly objectsLost: number;
  };
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function renderMarkdown(report: DrillReport): string {
  const lost = Object.entries(report.rpo.rowsLostPerTable).filter(([, n]) => n > 0);
  const phases = Object.entries(report.rto.phasesMs).map(([k, v]) => `| ${k} | ${secs(v)} |`);
  return [
    `# M36 restore drill - ${report.passed ? "PASS" : "FAIL"}`,
    "",
    `> **Demo scale, not production figures.** Private containers on one developer machine, a few dozen rows and ` +
      `a handful of small objects. These numbers prove the procedure and the verifier; they do not size production.`,
    "",
    `Run ${report.runId} at ${report.startedAt}. Fault injected: ${report.fault}.`,
    "",
    "## Backup method (what production really does)",
    ...Object.entries(report.backupMethod).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "## Measured RTO (demo scale)",
    `Restore wall time (new Postgres up, roles bootstrapped, dump loaded, object store restored): **${secs(report.rto.restoreWallMs)}**. Verification: ${secs(report.rto.verifyWallMs)}.`,
    "",
    "| phase | wall |",
    "|---|---|",
    ...phases,
    "",
    "## Measured RPO (demo scale)",
    `Backup taken ${report.rpo.backupAt}; source lost ${report.rpo.failureAt}. Data window lost: **${secs(report.rpo.dataWindowLostMs)}**` +
      ` (${lost.map(([t, n]) => `${n} ${t}`).join(", ") || "no rows"}; ${report.rpo.objectsLost} object(s)).`,
    "",
    "## Checks",
    "| result | check | detail |",
    "|---|---|---|",
    ...report.checks.map(
      (c) => `| ${c.ok ? "PASS" : "FAIL"} | ${c.name} | ${c.detail.replaceAll("|", "/")} |`,
    ),
    "",
  ].join("\n");
}

export function summarise(checks: readonly Check[]): { passed: boolean; failed: readonly Check[] } {
  const failed = checks.filter((c) => !c.ok);
  return { passed: failed.length === 0, failed };
}
