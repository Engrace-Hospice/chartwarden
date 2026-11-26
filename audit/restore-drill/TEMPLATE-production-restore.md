# Production restore drill - YYYY-MM-DD (TEMPLATE)

Copy this file and `TEMPLATE-production-restore.json` to `audit/restore-drill/<date>-production-restore.md` and
`<date>-production-restore.json` and fill both in. The JSON is what `bun run backup:drill-overdue` reads (the weekly
`restore-drill.yml` job fails and posts `backup.restore_drill_overdue` when the newest passing record is older than 35
days, or when the newest record is a failure); this file is the narrative a reviewer or auditor reads. Do not edit the
`TEMPLATE-*` files themselves. **Synthetic or redacted values only: no patient data, no secrets, no key material.**

What counts as a passing record (anything less is reported by the check and does not reset the clock):

- `witness` is a second person, not `conductedBy`;
- the verifier (`bun run backup:verify-restore`) exited 0, and `verifierExitCode` says so;
- the restored copy was destroyed (`restore.sh destroy <id>`), and `phiCopyDestroyedOn` says when;
- `result` is `pass`. A record with `result: "fail"` is the right record when the drill failed: it makes the check alarm
  until a later drill passes, which is the point.

The operator steps (the off-site key, the escrowed secrets, `restore.sh latest`, the verifier run, the leaked-key rehearsal)
are the checklist in issue #878, section 4; they are not repeated here. DR/BCP 4.8.6 is the command reference.

## Facts

| field | value |
| --- | --- |
| Conducted by / witness | |
| Host the restore ran on | (not the production host unless stated and justified) |
| Snapshot restored (`snapshotId`) | |
| Off-site key used | read-only restore key (`restore.json`), never the sidecar's |
| Restore id (`restore.sh`) | |
| Image / digest of the backup and verifier images | |

## Timing

| step | wall |
| --- | --- |
| `restore.sh latest` total (`RESTORE_WALL_MS` in `restore.env`) | |
| of which pgBackRest restore | |
| of which WAL replay and promotion | |
| of which objects copied and sha256-checked | |
| verifier (`backup:verify-restore`) | |

- **RTO observed** (`restoreWallSeconds`): ___ s, against the target in DR/BCP 3 (`rtoTargetSeconds`): ___ s.
- **RPO observed** (`snapshotAgeSeconds`: the age of the restored snapshot at the moment of the simulated failure): ___ s,
  against the target (`rpoTargetSeconds`): ___ s. DR/BCP 4.8.3 explains why the coordinated RPO is the snapshot interval plus
  up to two snapshot run times.
- Size of what was restored (database bytes, object count and bytes): ___

## Verification results

- [ ] Restore completed without error; PostgreSQL promoted at the marker LSN with `archive_mode=off`
- [ ] Verifier exit code 0, every check PASS (attach or paste the verifier's table, redacted)
- [ ] Migrations ledger and schema fingerprint equal the snapshot marker
- [ ] RLS smoke: no tenant context reads nothing; tenant A reads none of tenant B's rows (and the reverse)
- [ ] Every live row that references an object has it, sha256 equal to the snapshot and to the row
- [ ] M4 audit seals link and every sealed month recomputes
- [ ] Any `bytes-differ-from-row` or `not-in-snapshot` finding investigated before calling it data loss
- [ ] `cw-refresh-collation` run before anything read the restored database, if the snapshot predates the Wolfi image
- [ ] The restored PHI copy destroyed (`restore.sh destroy <id>`), and the destruction recorded above

## Findings

(Anything that surprised you, and anything that missed the RTO or RPO target. A miss is a finding, not a failed drill: the
record still passes if the restore verified. Open an issue for each and link it in `notes`.)

## Actions

(Follow-ups, owners, dates.)

## Next drill

(Monthly, first Saturday: DR/BCP 8.2. The check alarms after 35 days.)
