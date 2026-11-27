# Destroyed documents and their copies (CW-DS-01)

Operator runbook. A destruction certificate makes the M22 eraser destroy a patient's documents: every version of every
object in the primary store, then the rows. This runbook is about the other places those objects can still be: the second
copy, a restore, a hand load, the retired MinIO volume. Every step that deletes something is run **by a person**.

## What the code does now

- **Before** the eraser destroys an object it records an `object_destruction_tombstone` row (organization, bucket,
  object key, document and version ids, time). The row is committed first, so a crash mid-erase leaves the record and a
  retry finishes. The table is append-only for every role (a trigger refuses UPDATE and DELETE, a superuser's too,
  also under `session_replication_role = replica`; no application or destruction role holds TRUNCATE, but the table owner or a
  superuser can truncate it, and a database administrator who drops or disables the trigger, or drops the table, can remove
  rows); the application role can only read its own tenant's rows; the destruction role can insert
  for its own organization only, and only for a key that one of that organization's document versions records (a
  tombstone cannot be planted for an object nothing recorded). The table has no disposal path (its rows hold the patient's
  opaque id inside the key): that is the owner's decision.
- A document under an **active legal hold**, or a 42 CFR Part 2 document, is neither destroyed nor tombstoned. Release the
  hold and the next erase does both. The hold is read again inside the tombstone's own transaction: a hold placed since the
  erase began stops it with a 409 before anything is recorded or destroyed. A hold committed after that, while the objects
  are being deleted, is still missed.
- The export lists only **finished** erases: a tombstone whose key a document version still records (an erase that was cut
  short, or a document that was then held) is counted as `pending` on stderr and left out, so a held document's copy is
  never destroyed on the strength of it. The file ends with a trailer line with the record count, and the copy tool
  refuses a file without a matching one (an empty or half-written file is never "nothing to apply").
- Each tombstone is an audit event (`object_destruction_tombstone.insert`, retention class `compliance`) whose snapshot
  carries no object key (the key holds the patient's opaque id); the document row deletes are audited by their own
  triggers; the M4 certificate records the counts.
- `scripts/storage/object-tombstones.ts` exports the table as NDJSON, and `scripts/object-store-copy.ts --tombstones <file>`
  applies it: a listed object is never copied, and one already on the target is destroyed there (all versions), **outside
  the mass-delete guard**, **in a bucket the source no longer lists**, and **in a `--restore`**.
- **That destruction is a dry run until you say otherwise, and it is capped.** Without `--apply-tombstones`
  (`OBJECT_COPY_TOMBSTONES_APPLY=1` for the scheduled copy) the tool only counts what the target holds of the list and
  prints the counts on stderr before anything else happens; nothing is destroyed on the list's strength (a listed object is
  still never copied). With it, one run destroys at most `--max-deletions <n>` objects (`OBJECT_COPY_TOMBSTONES_MAX_DELETIONS`,
  default **100**, counted in objects the target holds, not in versions and not the size of the list; a run is held to it,
  but an hourly schedule can destroy up to it again each run). A plan above the limit is **refused whole**: nothing is
  destroyed on the list's strength, the run exits 1 (the scheduled copy pages `object_copy.failed`), the rest of the copy
  carries on, and the summary says `"tombstoneMode":"refused"`. A limit that is not a whole number >= 1, an apply value
  other than `1`/`0`, `--flag=value` spelled with an equals sign, or either setting without a list, stops the run before it
  starts. The forward copy's own delete-missing (bounded by the mass-delete guard) is a separate path and is not affected by
  any of this: in a dry run, or a refused plan, an object the source lost is still removed under the guard, as it always was
  (so the count printed is the count at the start of the run).
- **A one-off run takes `--apply-tombstones` and `--max-deletions` from its flags only.** `OBJECT_COPY_TOMBSTONES_APPLY` and
  `OBJECT_COPY_TOMBSTONES_MAX_DELETIONS` in `.env.production` are read by the scheduled copy only, so a
  `$COMPOSE run ... object-copy` you type as a dry run is one, whatever the environment says (it prints a note when it ignores
  them).

What it does **not** cover: objects destroyed before migration 1560; destruction of a whole tenant bucket (M34 shred,
Phase 2); objects other modules destroy (aborted uploads, M36 attachments); the off-site Object-Lock mirror (below); and
nothing schedules the export, so the copy is only as current as the last list you gave it.

## 1. After a destruction run: bring the copy in line

The forward copy already removes an object the primary no longer has, unless the mass-delete guard holds a large erasure
(more than max(10, 10%) of a bucket). The list removes that dependency. From the deploy directory on the primary host:

```sh
COMPOSE="docker compose --env-file .env.production -f compose.yml -f compose.object-copy.yml"
mkdir -p tombstones && sudo chown 1000:1000 tombstones && chmod 0700 tombstones   # PHI-adjacent (the keys carry patient ids); the containers run as uid 1000
# export to a temp file and move it into place, so a failed export never replaces a good list (set -e: stop on any failure)
set -e
$COMPOSE run --rm -T tenant-buckets bun run scripts/storage/object-tombstones.ts > tombstones/tombstones.ndjson.tmp
mv tombstones/tombstones.ndjson.tmp tombstones/tombstones.ndjson
tail -n 1 tombstones/tombstones.ndjson                  # the trailer: {"tombstones":N}, N = the lines above it
```

The exporter prints `exported N tombstone(s); P pending` on stderr. It uses `DATABASE_ADMIN_URL` only (the operator's
superuser or BYPASSRLS connection that `tenant-buckets` already has) and refuses a connection that is subject to row
security, because that would read no rows and an empty list must never look like "nothing was destroyed". Compare `N` with
`SELECT count(*) FROM object_destruction_tombstone` minus the `P` pending ones. A `pending` erase is one that has not
finished (or whose document was then held): finish or release it, then export again.

First a **dry run** (the default; the copy prints one JSON summary, and a line on stderr with the counts before anything is
touched). `tombstonesOnTarget` is how many listed objects the replica holds, i.e. what an apply would destroy:

```sh
$COMPOSE run --rm -T -v "$PWD/tombstones:/tombstones:ro" object-copy \
  bun run scripts/object-store-copy.ts --tombstones /tombstones/tombstones.ndjson
# stderr: tombstones: the list names 40 object(s) in 3 bucket(s); the target holds 37 of them (limit 100 per run). DRY RUN: ...
# stdout: {"...,"tombstoneMode":"dry-run","tombstonesOnTarget":37,"tombstoned":0,"failed":[]}
```

Check that count against what the certificates destroyed (checklist item 2 below), then **apply** it. `tombstoned` is the
number destroyed on the replica and `failed` must be `[]`:

```sh
$COMPOSE run --rm -T -v "$PWD/tombstones:/tombstones:ro" object-copy \
  bun run scripts/object-store-copy.ts --tombstones /tombstones/tombstones.ndjson --apply-tombstones
```

At most 100 objects are destroyed per run. If the dry run counted more, the apply is refused whole (exit 1, nothing destroyed,
`"tombstoneMode":"refused"`): check that the list is the one you exported and that the count is what the certificates account
for, then raise the limit for that run only, to at least the count, with `--max-deletions <n>` (a whole number you chose;
there is no "unlimited"). A count you cannot explain is a reason to stop and look at the list, not to raise the limit.

To keep the scheduled copy current, give the service the file (add a read-only bind mount of `./tombstones` and
`OBJECT_COPY_TOMBSTONES_FILE=/tombstones/tombstones.ndjson` to the `object-copy` service in an override file) and refresh the
export from cron after each destruction run. The copy re-reads the file on every run; a file that is named but unreadable
stops the run and pages (`object_copy.failed`). The schedule stays a **dry run** until you also set
`OBJECT_COPY_TOMBSTONES_APPLY=1` in `.env.production`. While it is one and the list names objects the replica holds, each
clean run posts an `object_copy.tombstones_pending` alert (counts only; the copy itself is healthy, so no `object_copy.failed`
and the heartbeat still beats): the replica holds destroyed documents until you apply. Each applied run is held to
`OBJECT_COPY_TOMBSTONES_MAX_DELETIONS` (default 100): a larger plan pages `object_copy.failed` instead of destroying. Raise that
limit only for as long as one catch-up run needs and put it back after; a value left in `.env.production` stays in force. The
flags `--apply-tombstones` and `--max-deletions` are refused together with `--every`, as `--tombstones` is, because the
schedule takes them from its environment.

## 2. Restoring objects

Whatever the source (the second copy, or a hand load from the off-site mirror), export the list from the database **as it
stands after its own restore** and apply it:

```sh
set -e
$COMPOSE run --rm -T tenant-buckets bun run scripts/storage/object-tombstones.ts > tombstones/tombstones.ndjson.tmp
mv tombstones/tombstones.ndjson.tmp tombstones/tombstones.ndjson
# restore from the second copy: the same tool in the other direction, with the list (do this BEFORE restarting object-copy).
# SOURCE_S3_* = copy, TARGET_S3_* = new primary. A listed object is never restored, with or without --apply-tombstones.
bun run scripts/object-store-copy.ts --restore --tombstones tombstones/tombstones.ndjson
# only if a hand load already put listed objects on the target: read the count above, then destroy them (at most 100 per run)
bun run scripts/object-store-copy.ts --restore --tombstones tombstones/tombstones.ndjson --apply-tombstones
```

`--every` does not take `--tombstones`: the scheduled copy reads `OBJECT_COPY_TOMBSTONES_FILE` only. On a **versioned**
target the copy tool lists current keys: a tombstoned key whose current version is a delete marker is not listed, so its
older versions are not touched; destroy such a key by hand.

A listed object the source still holds is skipped (`skippedTombstoned`); one a hand load already put on the target is
destroyed by the same command when `--apply-tombstones` is given (`tombstoned`), and only counted (`tombstonesOnTarget`) otherwise. The list is only as old as the database it came from: if the database is
restored to a point before a destruction, that destruction is not in it, and the certificate's erasure must be re-run
(DR/BCP §6.3 step 5) as before.

## 3. What a delete leaves on the primary's volume

SeaweedFS keeps a deleted object's bytes in its volume file until the volume is vacuumed. For an object stored encrypted
(`docs/runbooks/object-store-sse-cutover.md`) the remnant is ciphertext whose key was deleted with the object's entry. For
an object written before that cutover it is plaintext. After a destruction run, vacuum:

```sh
sleep 30   # the filer deletes the chunks in the background
$COMPOSE exec seaweedfs wget -qO- 'http://127.0.0.1:9333/vol/vacuum?garbageThreshold=0.0001' >/dev/null
```

The RustFS replica removes an object's files when it is deleted.

## 4. The copies this does not reach (decisions for the owner; nothing here deletes them)

- **The retired MinIO volume** (`<prefix>_minio-data`) is a full pre-cutover copy of every document **including ones
  destroyed since**, in plaintext, outside the backups. Removing it (`deploy/production/README.md`, "removing the retired MinIO
  data") is the owner's step and irreversible; until then a destroyed document is still readable on any host that has it.
- **The off-site Object-Lock mirror** keeps every object it ever copied (SSE-C under one platform key, a COMPLIANCE lock;
  nothing deletes there). A destruction does not reach it, and neither does a tenant's key destruction. Its only remedy
  is the list on a hand load (section 2), and the lock lapsing.
- **Database backups taken before a destruction** still hold the rows; their retention is the limit (DR/BCP §4.1).
- **Purged bereavement mailing batch files (CW-BR-10) have no tombstone.** The daily `m16-mailing-file-purge` job (execution is disabled in code today; it is a dry run) will destroy those PDFs (a name-and-address
  list each) but writes no `object_destruction_tombstone` (that table's `basis` admits only `patient_erasure` and only the destruction role inserts), so
  a second-copy sync or a restore with the list can bring one back. A full database-and-object restore brings the document row back `active` and the next
  purge run destroys it again; an objects-only restore does not. See `docs/runbooks/m16-mailing-file-purge.md`.

## Verifying a destruction (checklist)

1. The M4 certificate shows the counts and any `refusedLegalHold` / `refusedPartTwo` documents (those are kept on purpose).
2. `SELECT count(*) FROM object_destruction_tombstone WHERE organization_id = '<org>'` (operator connection) is at least the
   number of objects the certificate says were destroyed; the export lists no row for a held document's object (a row left by
   an unfinished erase that a hold then stopped is reported as `pending`, not exported).
3. The primary no longer lists the keys; the replica no longer lists them after section 1 (`tombstoned` in the summary, and
   a following dry run reports `tombstonesOnTarget: 0`).
4. The volume was vacuumed (section 3).
5. The owner has decided on the retired MinIO volume (section 4).
