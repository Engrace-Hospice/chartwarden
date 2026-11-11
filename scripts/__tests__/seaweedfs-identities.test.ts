import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_POLICY,
  READER_POLICY,
  buildS3Config,
  isCurrent,
  ownerOf,
  writeS3Config,
} from "../storage/seaweedfs-identities";

const base = {
  SEAWEEDFS_ADMIN_ACCESS_KEY: "admin",
  SEAWEEDFS_ADMIN_SECRET_KEY: "admin-secret-not-real-0001",
  SEAWEEDFS_APP_ACCESS_KEY: "app",
  SEAWEEDFS_APP_SECRET_KEY: "app-secret-not-real-00001",
};

describe("seaweedfs identities", () => {
  it("gives the app key only the app policy (never Admin) and readers only the reader policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-id-"));
    writeFileSync(join(dir, "backup"), "backup-secret-not-real-01\n");
    const config = buildS3Config({
      ...base,
      SEAWEEDFS_READER_BACKUP_ACCESS_KEY: "backup-reader",
      SEAWEEDFS_READER_BACKUP_SECRET_KEY_FILE: join(dir, "backup"),
      SEAWEEDFS_READER_COPY_ACCESS_KEY: "", // unset optional reader: skipped
    });
    const app = config.identities.find((i) => i.name === "app");
    expect(app).toMatchObject({ policyNames: [APP_POLICY] });
    expect(app?.actions).toBeUndefined();
    expect(config.identities.map((i) => i.name)).toEqual(["admin", "app", "reader-backup"]);
    expect(config.identities[2]?.credentials[0]?.secretKey).toBe("backup-secret-not-real-01");
    expect(config.identities[2]?.policyNames).toEqual([READER_POLICY]);
    const appPolicy = JSON.parse(config.policies[0]?.content ?? "{}");
    expect(JSON.stringify(appPolicy)).not.toMatch(/DeleteBucket|PutBucketVersioning|"s3:\*"/);
  });

  it("refuses a short secret and a shared access key", () => {
    expect(() => buildS3Config({ ...base, SEAWEEDFS_APP_SECRET_KEY: "short" })).toThrow(
      /at least 8/,
    );
    expect(() => buildS3Config({ ...base, SEAWEEDFS_APP_ACCESS_KEY: "admin" })).toThrow(
      /share an access key/,
    );
  });

  it("rewrites the file only when it changes, mode 0600", () => {
    const out = join(mkdtempSync(join(tmpdir(), "sw-out-")), "s3.json");
    const config = buildS3Config(base);
    expect(writeS3Config(out, config)).toBe(true);
    expect(writeS3Config(out, config)).toBe(false);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, "utf8")).identities).toHaveLength(2);
  });

  it("hands the file to the configured owner and treats a wrong owner as a change", () => {
    expect(ownerOf(undefined)).toBeNull();
    expect(ownerOf("1000:1000")).toEqual({ uid: 1000, gid: 1000 });
    expect(() => ownerOf("seaweed")).toThrow(/<uid>:<gid>/);
    const out = join(mkdtempSync(join(tmpdir(), "sw-own-")), "s3.json");
    const config = buildS3Config(base);
    expect(writeS3Config(out, config)).toBe(true);
    const text = readFileSync(out, "utf8");
    const { uid, gid } = statSync(out);
    expect(writeS3Config(out, config, { uid, gid })).toBe(false); // chowns to itself: allowed unprivileged
    expect(isCurrent(out, text, { uid, gid })).toBe(true);
    expect(isCurrent(out, text, { uid: uid + 1, gid })).toBe(false); // wrong owner: rewrite + restart
  });
});
