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

One run, to see what it does (the copy prints one JSON summary; `tombstoned` is the number it destroyed on the replica,
`failed` must be `[]`):

```sh
$COMPOSE run --rm -T -v "$PWD/tombstones:/tombstones:ro" object-copy \
  bun run scripts/object-store-copy.ts --tombstones /tombstones/tombstones.ndjson
```

To keep the scheduled copy current, give the service the file (add a read-only bind mount of `./tombstones` and
`OBJECT_COPY_TOMBSTONES_FILE=/tombstones/tombstones.ndjson` to the `object-copy` service in an override file) and refresh the
export from cron after each destruction run. The copy re-reads the file on every run; a file that is named but unreadable
stops the run and pages (`object_copy.failed`).

## 2. Restoring objects

Whatever the source (the second copy, or a hand load from the off-site mirror), export the list from the database **as it
stands after its own restore** and apply it:

```sh
set -e
$COMPOSE run --rm -T tenant-buckets bun run scripts/storage/object-tombstones.ts > tombstones/tombstones.ndjson.tmp
mv tombstones/tombstones.ndjson.tmp tombstones/tombstones.ndjson
# restore from the second copy: the same tool in the other direction, with the list (do this BEFORE restarting object-copy)
bun run scripts/object-store-copy.ts --restore --tombstones tombstones/tombstones.ndjson   # SOURCE_S3_* = copy, TARGET_S3_* = new primary
```

`--every` does not take `--tombstones`: the scheduled copy reads `OBJECT_COPY_TOMBSTONES_FILE` only. On a **versioned**
target the copy tool lists current keys: a tombstoned key whose current version is a delete marker is not listed, so its
older versions are not touched; destroy such a key by hand.

A listed object the source still holds is skipped (`skippedTombstoned`); one a hand load already put on the target is
destroyed by the same command (`tombstoned`). The list is only as old as the database it came from: if the database is
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

## Verifying a destruction (checklist)

1. The M4 certificate shows the counts and any `refusedLegalHold` / `refusedPartTwo` documents (those are kept on purpose).
2. `SELECT count(*) FROM object_destruction_tombstone WHERE organization_id = '<org>'` (operator connection) is at least the
   number of objects the certificate says were destroyed; no row exists for a held document's object.
3. The primary no longer lists the keys; the replica no longer lists them after section 1 (`tombstoned` in the summary).
4. The volume was vacuumed (section 3).
5. The owner has decided on the retired MinIO volume (section 4).
