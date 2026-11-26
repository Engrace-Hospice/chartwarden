import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// deploy/production/db-replication/provision-primary.sh edits the cluster's pg_hba.conf in place. A mistake there locks the
// application out of its own database, so the file handling is pinned here against a stubbed psql (no server): the block
// goes first and only once, the cluster's own rules survive byte for byte, an unbalanced marker is refused instead of
// eating the rest of the file, and a file the server does not accept is rolled back. The real behaviour (the rules do what
// they say) is proven by `bun run backup:replication-drill`.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "deploy/production/db-replication/provision-primary.sh");
const have = (cmd: string): boolean =>
  spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const suite = have("bash") ? describe : describe.skip;

const BEGIN =
  "# BEGIN cw-replication (managed by db-replication/provision-primary.sh; do not edit)";
const END = "# END cw-replication";
const STOCK = [
  "local   all             all                                     trust",
  "host    all             all             127.0.0.1/32            trust",
  "local   replication     all                                     trust",
  "host all all all scram-sha-256",
  "",
].join("\n");

const scratch = mkdtempSync(join(tmpdir(), "repl-provision-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const bin = join(scratch, "bin");
mkdirSync(bin);
// A psql that answers the handful of questions the script asks and records every statement it was given.
writeFileSync(
  join(bin, "psql"),
  `#!/bin/sh
in="$(cat)"
q="$* $in"
printf '%s\\n' "$q" >>"$FAKE_PSQL_LOG"
case "$q" in
  *pg_is_in_recovery*) echo f ;;
  *"SHOW ssl"*) echo on ;;
  *"SHOW hba_file"*) echo "$FAKE_HBA" ;;
  *"error IS NOT NULL"*) echo "\${FAKE_HBA_ERRORS:-0}" ;;
  *"auth_method = 'cert'"*) echo "\${FAKE_CERT_SEEN:-1}" ;;
esac
`,
);
chmodSync(join(bin, "psql"), 0o755);

function provision(hba: string, env: Readonly<Record<string, string>> = {}) {
  const log = join(scratch, `psql-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  const res = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_HBA: hba,
      FAKE_PSQL_LOG: log,
      REPLICATION_STANDBY_CIDR: "203.0.113.7/32",
      ...env,
    },
  });
  return { ...res, statements: readFileSync(log, "utf8") };
}
const newHba = (content: string): string => {
  const dir = mkdtempSync(join(scratch, "hba-"));
  const file = join(dir, "pg_hba.conf");
  writeFileSync(file, content);
  return file;
};

suite("provision-primary.sh", () => {
  it("prepends the managed block once, pinned to the standby, and keeps every existing rule", () => {
    const hba = newHba(STOCK);
    const res = provision(hba);
    expect(res.status, res.stderr).toBe(0);
    const out = readFileSync(hba, "utf8");
    expect(out).toBe(
      `${[
        BEGIN,
        "hostssl replication cw_replicator 203.0.113.7/32 cert",
        "host    replication cw_replicator all reject",
        "host    all         cw_replicator all reject",
        END,
      ].join("\n")}\n${STOCK}`,
    );
    expect(readFileSync(`${hba}.pre-cw-replication`, "utf8")).toBe(STOCK);
  });

  it("is idempotent, and a changed standby address replaces the block instead of adding a second", () => {
    const hba = newHba(STOCK);
    expect(provision(hba).status).toBe(0);
    const once = readFileSync(hba, "utf8");
    const again = provision(hba);
    expect(again.status).toBe(0);
    expect(again.stderr).toMatch(/already carries the managed block/);
    expect(readFileSync(hba, "utf8")).toBe(once);
    expect(provision(hba, { REPLICATION_STANDBY_CIDR: "203.0.113.9/32" }).status).toBe(0);
    const moved = readFileSync(hba, "utf8");
    expect(moved.split(BEGIN).length - 1).toBe(1);
    expect(moved).toContain("203.0.113.9/32");
    expect(moved).not.toContain("203.0.113.7/32");
    expect(moved.endsWith(STOCK)).toBe(true);
  });

  it("refuses a BEGIN without its END instead of dropping the rest of the file", () => {
    const broken = `${BEGIN}\nhostssl replication cw_replicator all cert\n${STOCK}`;
    const hba = newHba(broken);
    const res = provision(hba);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/without its END line/);
    expect(readFileSync(hba, "utf8")).toBe(broken);
  });

  it("puts the previous file back and reloads when the server does not accept the new one", () => {
    const hba = newHba(STOCK);
    const res = provision(hba, { FAKE_HBA_ERRORS: "1" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/previous file is back in place/);
    expect(readFileSync(hba, "utf8")).toBe(STOCK);
    expect((res.statements.match(/pg_reload_conf/g) ?? []).length).toBe(2); // the change, then the rollback
  });

  it("fails when the server does not list the cert rule after the reload", () => {
    const hba = newHba(STOCK);
    const res = provision(hba, { FAKE_CERT_SEEN: "0" });
    expect(res.status).toBe(1);
    expect(readFileSync(hba, "utf8")).toBe(STOCK);
  });

  it("converges the role on every run (no password, no other attribute, a connection limit) and creates the slot once", () => {
    const res = provision(newHba(STOCK));
    expect(res.statements).toMatch(
      /ALTER ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD NULL CONNECTION LIMIT/,
    );
    expect(res.statements).toMatch(/pg_create_physical_replication_slot/);
    // the change leaves a line in the SERVER log (the one-shot's own stderr is gone once it is removed)
    expect(res.statements).toMatch(/RAISE LOG/);
    expect(res.statements).toMatch(
      /cw-replication: replication role cw_replicator, slot cw_standby/,
    );
    expect(res.statements).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM pg_replication_slots/);
  });

  it.each([
    ["a missing address", { REPLICATION_STANDBY_CIDR: "" }],
    ["every address", { REPLICATION_STANDBY_CIDR: "0.0.0.0/0" }],
    ["a wide IPv4 network", { REPLICATION_STANDBY_CIDR: "10.0.0.0/8" }],
    ["a /16", { REPLICATION_STANDBY_CIDR: "10.1.0.0/16" }],
    ["a /24 (it is one host or nothing)", { REPLICATION_STANDBY_CIDR: "203.0.113.0/24" }],
    ["a /31", { REPLICATION_STANDBY_CIDR: "203.0.113.6/31" }],
    ["an IPv6 /64", { REPLICATION_STANDBY_CIDR: "2001:db8::/64" }],
    ["a host name", { REPLICATION_STANDBY_CIDR: "standby.example.test/32" }],
    ["a bare address with no prefix", { REPLICATION_STANDBY_CIDR: "203.0.113.7" }],
    ["every IPv6 address", { REPLICATION_STANDBY_CIDR: "::/0" }],
  ])("refuses %s as the standby address, leaving the file alone", (_name, env) => {
    const hba = newHba(STOCK);
    const res = provision(hba, env);
    expect(res.status).not.toBe(0);
    expect(readFileSync(hba, "utf8")).toBe(STOCK);
  });

  // The port is published on REPLICATION_PUBLISH_ADDR and carries every role's password login: a wildcard is refused before
  // any change (the role, the slot, pg_hba.conf).
  it.each([["0.0.0.0"], ["::"], ["[::]"], ["0:0:0:0:0:0:0:0"], ["0"]])(
    "refuses the wildcard publish address %s before touching anything",
    (addr) => {
      const hba = newHba(STOCK);
      const res = provision(hba, { REPLICATION_PUBLISH_ADDR: addr });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/wildcard/);
      expect(readFileSync(hba, "utf8")).toBe(STOCK);
      expect(res.statements).not.toMatch(/CREATE ROLE|pg_create_physical_replication_slot/);
    },
  );

  it("accepts a private publish address, and a by-hand run that does not set it", () => {
    const envs: ReadonlyArray<Record<string, string>> = [
      { REPLICATION_PUBLISH_ADDR: "10.20.30.40" },
      {},
    ];
    for (const env of envs) {
      const res = provision(newHba(STOCK), env);
      expect(res.status, res.stderr).toBe(0);
    }
  });

  it("accepts a /128 IPv6 standby", () => {
    const hba = newHba(STOCK);
    const res = provision(hba, { REPLICATION_STANDBY_CIDR: "2001:db8::7/128" });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(hba, "utf8")).toContain(
      "hostssl replication cw_replicator 2001:db8::7/128 cert",
    );
  });

  it("refuses to run against a standby or without TLS", () => {
    const hba = newHba(STOCK);
    const variants: ReadonlyArray<readonly [string, RegExp, string]> = [
      ["standby", /standby/, 'case "$*" in *pg_is_in_recovery*) echo t;; esac'],
      [
        "no-tls",
        /ssl is off/,
        'case "$*" in *pg_is_in_recovery*) echo f;; *"SHOW ssl"*) echo off;; esac',
      ],
    ];
    for (const [name, message, answer] of variants) {
      const stub = join(scratch, `psql-${name}`);
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "psql"), `#!/bin/sh\ncat >/dev/null\n${answer}\n`);
      chmodSync(join(stub, "psql"), 0o755);
      const res = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          PATH: `${stub}:${process.env.PATH ?? ""}`,
          FAKE_HBA: hba,
          REPLICATION_STANDBY_CIDR: "203.0.113.7/32",
        },
      });
      expect(res.status, name).toBe(1);
      expect(res.stderr, name).toMatch(message);
      expect(readFileSync(hba, "utf8")).toBe(STOCK);
    }
  });
});
