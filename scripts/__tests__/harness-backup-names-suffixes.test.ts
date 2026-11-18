/**
 * Wave 6, CR-L4 (round-4 code review): a copy of a secret file is that secret. `backupName` took at most three suffixes
 * off and knew only `.bak .orig .old .save .swp ~`, so `tls.key.bak.swp.orig.old` (four), `server.pem.1`,
 * `server.pem-2024` and `key.pem.tmp` allowed. It now reads up to eight suffixes and also `.tmp .temp .copy .prev`, a
 * numeric `.N` (log rotation) and a dated or numbered `-NN…`. The suffix only changes the answer when the ORIGINAL name is
 * a secret (or a template, which stays readable), so an everyday file with a number on the end is as allowed as it was:
 * `.bak` alone still marks a database backup, and no new suffix does.
 */
import { describe, expect, it } from "vitest";
import { backupName } from "../harness/backup-names";
import { classifyBash, secretPathReason } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
/** A live env file's name, built so this file never spells it out. */
const ENV = [".", "en", "v"].join("");

describe("backupName reads every suffix a copy can carry", () => {
  it.each<[string, string, boolean]>([
    ["tls.key.bak.swp.orig.old", "tls.key", true],
    ["tls.key.bak.swp.orig.old.save~", "tls.key", true],
    ["server.pem.1", "server.pem", true],
    ["server.pem.12", "server.pem", true],
    ["server.pem-2024", "server.pem", true],
    ["server.pem-20241105", "server.pem", true],
    ["server.pem.20241105", "server.pem", true],
    ["key.pem.tmp", "key.pem", true],
    ["key.pem.temp", "key.pem", true],
    ["key.pem.copy", "key.pem", true],
    ["key.pem.prev", "key.pem", true],
    ["key.pem.1.bak", "key.pem", true],
    ["src/x.ts", "src/x.ts", false],
    ["src/x.ts.map", "src/x.ts.map", false],
    ["node-v18.2.0", "node-v18", true],
    ["a-1", "a-1", false],
  ])("%s -> %s (copy: %s)", (name, original, isCopy) => {
    const got = backupName(name);
    expect(got.isCopy).toBe(isCopy);
    expect(got.original).toBe(original);
  });
  it("only `.bak` marks a database backup, as before", () => {
    expect(backupName("prod.bak").mayBeDatabaseBackup).toBe(true);
    expect(backupName("prod.1").mayBeDatabaseBackup).toBe(false);
    expect(backupName("prod.tmp").mayBeDatabaseBackup).toBe(false);
    expect(backupName("prod-2024").mayBeDatabaseBackup).toBe(false);
  });
  it("takes a bounded number off a hostile name, in a hostile name's time", () => {
    const started = performance.now();
    const hostile = `x${".1".repeat(100_000)}`;
    expect(backupName(hostile).original.length).toBeLessThan(hostile.length);
    // A wall-clock bound only guards against a super-linear blow-up (these inputs took seconds when a rule went quadratic), not a micro-benchmark: it is 3 s so a loaded CI machine cannot fail it.
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("a copy of a secret is the secret, however it is numbered", () => {
  it.each([
    "tls.key.bak.swp.orig.old",
    "deploy/production/tls/server.pem.1",
    "deploy/production/tls/server.pem-2024",
    "deploy/production/tls/server.key.2024",
    "key.pem.tmp",
    "certs/id_rsa.1",
    "certs/id_ed25519-2024",
    `apps/backend/${ENV}.tmp`,
    `apps/backend/${ENV}.1`,
    `apps/backend/${ENV}-20241105`,
    `apps/backend/${ENV}.copy`,
    `apps/backend/${ENV}.bak.swp.orig.old`,
  ])("is a secret: %s", (path) => {
    expect(secretPathReason(path), path).not.toBeNull();
    expect(d(`cat ${path}`), path).toBe("deny");
  });

  it.each([
    "src/x.ts.1",
    "src/x.ts-2024",
    "package.json.tmp",
    "docs/notes.txt.copy",
    "libfoo.so.1",
    "apps/web/src/index.tsx.prev",
    `apps/backend/${ENV}.example.1`,
    `deploy/production/${ENV}.production.example-2024`,
    "scripts/report-2024.ts",
  ])("is not: %s", (path) => {
    expect(secretPathReason(path), path).toBeNull();
    expect(d(`cat ${path}`), path).toBe("allow");
  });
});
