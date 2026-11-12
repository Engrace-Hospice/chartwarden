/**
 * Wave 4, T7: a backup COPY of a file is as sensitive as the file and no more. `sed -i.bak … .gitleaks.toml && rm -f
 * .gitleaks.toml.bak` was refused as "a database dump or backup (may hold PHI)" for the `.bak` alone (and so was every
 * `src/x.ts.bak`), while `.env~`, `tls.key.orig` and `server.pem.save` (a key's or an env file's copy) were not
 * refused at all. The copy suffix (`.bak`, `~`, `.orig`, `.old`, `.save`, `.swp`) is taken off and the original's name
 * is judged; only a `.bak` of an original that says nothing is a database backup.
 */
import { describe, expect, it } from "vitest";
import { backupName } from "../harness/backup-names";
import { classifyBash, secretPathReason } from "../harness/patterns";

/** Env file names, built so this file never spells them out. */
const ENV = [".", "env"].join("");
const secret = (p: string) => secretPathReason(p) !== null;

describe("backupName", () => {
  it.each<[string, string, boolean, boolean]>([
    ["src/x.ts.bak", "src/x.ts", true, false],
    ["notes.txt~", "notes.txt", true, false],
    ["package.json.orig", "package.json", true, false],
    ["a.sql.old", "a.sql", true, false],
    ["k.pem.save", "k.pem", true, false],
    [".x.ts.swp", ".x.ts", true, false],
    ["prod.bak", "prod", true, true],
    ["patients.sql.bak", "patients.sql", true, true],
    ["x.ts.bak~", "x.ts", true, false],
    ["x.ts", "x.ts", false, false],
    // A rotation number is a suffix too (CR-L4): `x.bak.2` is a copy of `x`, and only a trailing `.bak` marks a database backup.
    ["x.bak.2", "x", true, false],
  ])("%s -> %s (copy %s, may be a database backup %s)", (name, original, isCopy, db) => {
    expect(backupName(name)).toEqual({ original, isCopy, mayBeDatabaseBackup: db });
  });

  it("takes off a bounded number of suffixes", () => {
    expect(backupName(`x${".bak".repeat(50)}`).isCopy).toBe(true);
    expect(backupName(`x${".bak".repeat(50)}`).original).toBe(`x${".bak".repeat(42)}`);
  });
});

describe("secretPathReason on backup copies", () => {
  it.each([
    `${ENV}.bak`,
    `apps/backend/${ENV}.bak`,
    `apps/web/${ENV}.production.bak`,
    `${ENV}~`,
    `${ENV}.orig`,
    `${ENV}.old`,
    "deploy/production/backend.env.bak",
    "tls.key.bak",
    "tls.key.orig",
    "server.pem.save",
    "id_rsa.bak",
    "prod.sql.bak",
    "prod.bak",
    "patients.bak",
    "db.sql.gz.bak",
    ".pgpass.bak",
    "data.sqlite.bak",
    "x.dump",
    "x.backup",
    "db.sql.gz",
    "a.sql.zst",
    "backup.tar.gz",
    "backups/2026-11-11.tar",
    "nightly-backup.tgz",
  ])("refuses %s", (path) => {
    expect(secret(path), path).toBe(true);
  });

  it.each([
    ".gitleaks.toml.bak",
    "src/x.ts.bak",
    "apps/backend/src/a.ts.bak",
    "scripts/x.sh.bak",
    "README.md.bak",
    "package.json.orig",
    "docs/x.md.old",
    "notes.txt~",
    "x.json~",
    ".x.ts.swp",
    ".gitleaks.toml.bak.2",
    `${ENV}.example.bak`,
    "a.sql",
    "docs/backup-policy.md",
    "scripts/backup-restore.sh",
  ])("allows %s", (path) => {
    expect(secret(path), path).toBe(false);
  });
});

describe("the real shape: sed -i.bak and its cleanup", () => {
  const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
  it("is no longer refused as a database backup, and the other copies still are", () => {
    expect(
      classifyBash("sed -i.bak 's/a/b/' apps/web/src/x.tsx && rm -f apps/web/src/x.tsx.bak", ctx)
        .decision,
    ).toBe("allow");
    expect(classifyBash("sed -i.bak 's/a/b/' README.md && rm -f README.md.bak", ctx).decision).toBe(
      "allow",
    );
    expect(classifyBash("cat prod.sql.bak", ctx).decision).toBe("deny");
    expect(classifyBash(`cat apps/backend/${ENV}.bak`, ctx).decision).toBe("deny");
    expect(classifyBash("cat tls.key.orig", ctx).decision).toBe("deny");
  });
});
