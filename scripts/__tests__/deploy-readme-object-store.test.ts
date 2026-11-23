import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// deploy/production/README.md is the operator's contract for the object-store variables. These checks pin the sections an
// operator acts on (the contract table, the retired MinIO rollback window, the host-side leftovers), so the README cannot
// drift back to documenting aliases, a cutover or a compatibility path that no longer exist.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("deploy/production/README.md documents the object-store contract", () => {
  const readme = read("deploy/production/README.md");

  it("names each layer of the contract and the canonical audit path", () => {
    for (const needle of [
      "OBJECT_STORE_*",
      "SEAWEEDFS_ADMIN_ACCESS_KEY",
      "SEAWEEDFS_APP_SECRET_KEY",
      "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN",
      "/api/v1/webhooks/object-store/access-log",
      "RustFS",
      "BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY",
      "backup_source_object_store_secret_key",
      "RESTORE_OBJECT_STORE_",
    ]) {
      expect(readme, needle).toContain(needle);
    }
  });

  it("says the MinIO rollback window is retired, and what a host may still carry or delete", () => {
    expect(readme).toContain("### Retired: the MinIO rollback window");
    for (const needle of [
      "the backend ignores",
      "the old exit 78 is gone",
      "`BACKUP_SOURCE_MINIO_ACCESS_KEY`",
      "`<prefix>_minio-data`",
      "never fails the deploy",
    ]) {
      expect(readme, needle).toContain(needle);
    }
  });

  it("documents the temporary alias bridge and the order for removing it (repin the backup image first)", () => {
    expect(readme).toContain(
      "TEMPORARY ALIAS: delete when\n  CHARTWARDEN_BACKUP_IMAGE is repinned to an image built from this commit",
    );
    for (const needle of [
      "RESTORE_MINIO_IMAGE",
      "BACKUP_SOURCE_MINIO_URL",
      "**Order:**",
      "THEN delete the alias blocks",
    ]) {
      expect(readme, needle).toContain(needle);
    }
  });

  it("says deploy.sh fails the deploy, before migrations, when fluent-bit is not on the canonical audit path", () => {
    expect(readme).toContain("no longer treats `fluent-bit` as best-effort");
    expect(readme).toContain("requires the canonical path");
  });

  it("makes the disposal of the retired plaintext volume explicit, irreversible, owner-dated and enforced by preflight", () => {
    const section = readme.slice(
      readme.indexOf("## Object store: removing the retired MinIO data"),
    );
    for (const needle of [
      "in plaintext, outside the backups",
      "docker volume rm <prefix>_minio-data",
      "This is irreversible",
      "The deadline for step 2 is the owner's decision",
      "WARNING",
      "refuses",
      "EMPTY object store",
    ]) {
      expect(section, needle).toContain(needle);
    }
    // No invented date: the section names no deadline of its own.
    expect(section.slice(0, section.indexOf("## Object store: second copy"))).not.toMatch(
      /20\d\d-\d\d-\d\d/,
    );
  });

  it("no longer documents the removed pieces as live: no pair table, no cutover steps, no compatibility path", () => {
    expect(readme).not.toContain("Fail closed on a mismatch");
    expect(readme).not.toContain("The SeaweedFS cutover");
    expect(readme).not.toContain("object-store-migrate`'s");
    expect(readme).not.toContain("temporary compatibility path");
    expect(readme).not.toContain("| `SEAWEEDFS_ADMIN_ACCESS_KEY` | `MINIO_ROOT_USER` |");
  });

  it("the historical infra-rename runbook carries the superseded note for its MinIO steps", () => {
    expect(read("deploy/production/INFRA_RENAME_RUNBOOK.md")).toContain(
      "**Superseded for the object store (historical runbook).**",
    );
  });
});
