# Object store: server-side encryption cutover (CW-AC-05)

Operator runbook. Every step here changes production state and is run **by a person**; nothing in the repo
runs it. Documents were stored in the clear in the object store (SeaweedFS, ADR-0050 D6). The code now asks the
store to encrypt every object (SSE-S3, AES256) and sets an encryption default on every tenant bucket; this runbook
puts the store's key in place, turns that on, re-encrypts the objects written before, and removes the plaintext.

## What protects what

- **SSE-S3.** SeaweedFS encrypts each object under its own key and wraps that key under a key-encryption key
  (KEK). The KEK is `WEED_S3_SSE_KEK`, set from `SEAWEEDFS_SSE_KEK` in `.env.production`. It is **not** in the data
  volume, so a copy of the volume (a snapshot, a disk, a retained copy of an old release's volume) is ciphertext
  without that value.
- **One KEK for the store, not a key per tenant.** The tenant DEK shred (M34) does not seal objects; destroying
  a tenant's DEK does not make their documents unreadable. What a delete does is in the last section.
- **The KEK sits on the same host as the store process.** An attacker with a shell on the host can read the
  environment. This closes theft of disks, volume copies and snapshots; it does not close host compromise.
- **Not covered here:** the retired MinIO volume (step 8, by hand), host disk encryption (still unasserted), the
  off-site mirror (already SSE-C under its own key), KEK rotation (not built), a key per tenant (not built).

## Before you start

- A SeaweedFS **backup snapshot** you have restored somewhere or trust (README, "Object store: removing the
  retired MinIO data" lists what counts), and `OBJECT_STORE_REQUIRE_SSE` unset.
- **Losing `SEAWEEDFS_SSE_KEK` loses every encrypted object.** Generate it once, store it offline with the other
  escrowed keys (DR/BCP §4.8.5 lists it) **before** step 1, and check the escrow copy opens.
- Do not set `OBJECT_STORE_REQUIRE_SSE` before the key is deployed. SeaweedFS 4.52 with no key runs with SSE-S3 disabled and
  answers every write to a bucket that has an encryption default (or names SSE) with a 500, so the flag without the key takes
  uploads down (`preflight.sh` refuses the flag without a well-formed key for this reason). With the flag off and no key,
  nothing changes: that is how production runs today.

All commands run in the deploy directory on the primary host (the one holding `.env.production`), in one shell:

```sh
umask 077                                  # the journal and any file below are PHI-adjacent: owner-only
COMPOSE="docker compose --env-file .env.production -f compose.yml"      # what deploy.sh uses
```

The admin secret is passed to containers by NAME (`-e NAME`, from exported variables), never as `-e NAME=value`, so it
does not appear in `ps` or `docker inspect` arguments. Unset it when you finish (`unset ADMIN_AK ADMIN_SK AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY OBJECT_STORE_ACCESS_KEY OBJECT_STORE_SECRET_KEY`). **Pause tenant erasure and patient destruction
while steps 5 to 7 run**: the tool reads then writes an object, and a destroy of the same key between the two would be undone.

## 1. Put the key in place

```sh
openssl rand -hex 32          # copy it to the offline escrow NOW; this is the only time it is shown
# add to .env.production (0600):   SEAWEEDFS_SSE_KEK=<the 64 hex characters>
./deploy.sh                   # recreates seaweedfs with WEED_S3_SSE_KEK; behaviour is unchanged (flag still off)
$COMPOSE logs seaweedfs 2>&1 | grep 'Loaded KEK from s3.sse.kek config'     # must print one line
```

## 2. Turn encryption on

```sh
# add to .env.production:   OBJECT_STORE_REQUIRE_SSE=1
./deploy.sh
```

`preflight.sh` runs first and refuses the flag without the key. The `tenant-buckets` job then sets the encryption
default on every tenant bucket (`tenant buckets: N created, M already present, 0 failed` must show 0 failed). From
here every new write is encrypted, and an upload the store reports as not encrypted is refused and removed.

Check: upload any document in the app, then
`$COMPOSE exec seaweedfs sh -c 'grep -rlF "%PDF-" /data || echo none'` must not list the new document's volume file
(it will list volumes that still hold older plaintext, until step 7).

## 3. Enable versioning on every bucket to be re-encrypted

The re-encryption tool never overwrites the plaintext original: it writes a new version and the original becomes a
non-current version. It refuses a bucket without versioning. The app key cannot change versioning; use the admin key.

```sh
export ADMIN_AK=$(sed -n 's/^SEAWEEDFS_ADMIN_ACCESS_KEY=//p' .env.production)
export ADMIN_SK=$(sed -n 's/^SEAWEEDFS_ADMIN_SECRET_KEY=//p' .env.production)
export AWS_ACCESS_KEY_ID=$ADMIN_AK AWS_SECRET_ACCESS_KEY=$ADMIN_SK AWS_DEFAULT_REGION=us-east-1
# Pin the aws-cli image to a version or digest you have vetted; it receives the admin key.
S3="docker run --rm --network host -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION amazon/aws-cli --endpoint-url http://127.0.0.1:9000"
for b in $($S3 s3api list-buckets --query 'Buckets[].Name' --output text); do
  case "$b" in tenant-*|chartwarden-*) $S3 s3api put-bucket-versioning --bucket "$b" --versioning-configuration Status=Enabled ;; esac
done
```

(`127.0.0.1:9000` is the host port of the SeaweedFS S3 gateway.) Existing objects become the bucket's "null"
version; nothing is rewritten by this. A bucket created after this step is not versioned: that is fine while it holds only
encrypted objects (the tool asks for versioning only when it finds plaintext), but enable it before the next apply if the
dry run reports it.

## 4. Dry run

```sh
mkdir -p reencrypt && chmod 0777 reencrypt     # the container runs as a non-root uid and must be able to create the journal;
                                               # the journal file itself is created 0600
export OBJECT_STORE_ACCESS_KEY=$ADMIN_AK OBJECT_STORE_SECRET_KEY=$ADMIN_SK
RUN="$COMPOSE run --rm -T -v $PWD/reencrypt:/journal -e OBJECT_STORE_ACCESS_KEY -e OBJECT_STORE_SECRET_KEY tenant-buckets bun run scripts/storage/reencrypt-objects.ts --journal /journal/reencrypt.ndjson"
$RUN        # no --apply: reads and reports only
```

It prints one JSON line: `objects`, `alreadyEncrypted`, `pending` (plaintext objects it would rewrite),
`pendingBytes`, `failed`. `failed` must be `[]`; each entry names a bucket and key:

- *versioning is not enabled*: enable it (step 3), then re-run.
- *over --max-bytes*: the default is 32 MiB because the one-shot container has 256 MiB and reads an object whole. Re-run with
  `--max-bytes 536870912` (512 MiB) and enough memory for it (a library video can be that large): run the tool with
  `docker run --memory 2g` on the api image instead of `$COMPOSE run`, or raise `mem_limit` for the run.
- *no stored SHA-256*: rendered documents written without a checksum. Re-run with `--adopt-unchecksummed`: the new version
  is then checked against the SHA-256 of the bytes read (the source's own integrity cannot be proven).

## 5. Apply, in stages

```sh
$RUN --apply --limit 50        # a first small batch
$RUN --apply                   # the rest; safe to stop and run again: it continues where it stopped
```

Each rewrite is checked before it counts: the bytes read match the object's stored SHA-256; the new version is
reported encrypted, with the same SHA-256 and size; it reads back as the same bytes; the original version is still
readable. Any failed check leaves that object alone and is listed in `failed` (exit 1). `reencrypt/reencrypt.ndjson` gets an
`intent` line BEFORE each rewrite and a `reencrypted` (or `failed`) line after, each with `supersededVersionId`, the plaintext
version still on the volume. A journal that cannot be written stops the run. The container runs as uid 1000 and creates the
journal 0600, so read it on the host as that uid (or with `sudo`).

Spot check an object:

```sh
$S3 s3api head-object --bucket <bucket> --key <key>     # "ServerSideEncryption": "AES256"
```

## 6. Gate: nothing left to do

Run the dry run again. `pending` must be `0` and `failed` `[]`. Do not continue until it is.

## 7. Remove the plaintext originals (destructive: needs the owner's go-ahead)

The originals are the plaintext versions the journal's `intent` lines name. Do not decide by hand which are safe: the tool's
read-only `--verify` does. For each one it checks that the object's current version is reported encrypted, carries the
journaled SHA-256, **reads back as bytes with that SHA-256**, and is not the plaintext version itself; an object with a `failed`
line, or any check that fails, is held with its reason. It deletes nothing. A version id can be `null` (an object written
before versioning was enabled). Delete exactly the `purgeable` lines, then compact the volume (SeaweedFS keeps a deleted
object's bytes in the volume file until a vacuum):

```sh
$RUN --verify /journal/reencrypt.ndjson > reencrypt/purgeable.ndjson     # exit 1 while anything is held: read the `hold` lines, fix, re-run
jq -r 'select(.status=="purgeable") | [.bucket,.key,.supersededVersionId] | @tsv' reencrypt/purgeable.ndjson |
  while IFS="$(printf '\t')" read -r bucket key version; do
    $S3 s3api delete-object --bucket "$bucket" --key "$key" --version-id "$version"
  done
sleep 30   # the filer deletes the chunks in the background
$COMPOSE exec seaweedfs wget -qO- 'http://127.0.0.1:9333/vol/vacuum?garbageThreshold=0.0001' >/dev/null
sleep 30
$COMPOSE exec seaweedfs sh -c 'grep -rlF "%PDF-" /data || echo none'      # must print: none
```

`none` is the proof that no stored PDF is readable on the volume. It does not cover images or DOCX (their own headers):
also run the dry run once more, and `$S3 s3api list-object-versions --bucket <bucket> --query 'length(Versions)'` on a few
buckets must now equal the number of objects (no non-current version left). A `hold` line from `--verify` means that object is
not safe to purge: fix it (re-run step 5, then `--verify` again) first.

## 8. The other plaintext copies (destructive: needs the owner's go-ahead)

- **The retired MinIO volume** (`<prefix>_minio-data`): README, "Object store: removing the retired MinIO data". Do
  this only after steps 5 to 7 and a successful backup snapshot. It is a full plaintext copy of every document.
- **The second copy (RustFS, not enabled in production):** before enabling it, set `RUSTFS_KMS_MASTER_KEY` on the
  replica host (`replica/compose.yml`), run `rustfs-provision`, and set `OBJECT_COPY_TARGET_REQUIRE_SSE=1` on the
  primary. The copy then sets the encryption default on every replica bucket and fails any object the replica does not
  report encrypted; a plaintext copy already on the replica is rewritten on the next run.
- **Disaster recovery:** a restored SeaweedFS needs the same `SEAWEEDFS_SSE_KEK` (DR/BCP §4.8.5). `restore.sh` and the
  coordinated drill restore into a scratch store that does not use it, so they prove the object bytes, not the key: do
  not read a green drill as proof the key is recoverable. The off-site mirror is unchanged: the backup sidecar reads through
  the S3 API (so it receives plaintext from the store) and writes SSE-C under its own key.
- **Not detected:** `preflight.sh` checks the key's shape, not that it is the key the data was encrypted with, and cannot see
  that it was removed after the flag was turned off. Never remove it (rollback, below).

## Rollback

`OBJECT_STORE_REQUIRE_SSE=0` and deploy: the app stops naming SSE and stops checking it. Objects already encrypted
stay readable (the store decrypts them as long as it has the KEK) and new ones are still encrypted by the bucket default.
To stop encrypting new objects, remove the bucket defaults with the admin key
(`aws s3api delete-bucket-encryption`). **Never remove `SEAWEEDFS_SSE_KEK`** while any encrypted object exists.

## What a delete does (CW-DS-01)

A SeaweedFS delete removes the object's entry (and with it the wrapped per-object key); the bytes stay in the volume file
until the volume is vacuumed. For an encrypted object that remnant is ciphertext whose key is gone. For an object
written before this cutover it is **plaintext until the vacuum**, which is why step 7 vacuums. After a destruction
under a certificate, the same vacuum call (step 7) clears any plaintext remnant of a pre-cutover object.
