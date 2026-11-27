import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  postgresSettings,
  resolveDefaults,
  serviceCommand,
} from "../lib/replication/compose-command";

// The streaming-replication config as code (CW-CP-01): the primary overlay and the standby project must agree with each
// other and with the compose files they overlay. These are the drifts that fail silently in production: an overlay
// `command` REPLACES the list it overlays (so a forgotten flag turns WAL archiving or the lock table off), and a hot
// standby that undercuts the primary's max_locks_per_transaction or max_wal_senders refuses to start recovery.
// `bun run backup:replication-drill` starts real containers with these exact commands.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROD = join(REPO, "deploy/production");
const REPL = join(PROD, "db-replication");
const OVERLAY = join(PROD, "compose.replication.yml");
const STANDBY = join(REPL, "compose.standby.yml");
const BACKUP_IMAGE = "${CHARTWARDEN_BACKUP_IMAGE:?set-digest-pinned-GHCR-reference}";
const GIB = 1024 ** 3;

interface Service {
  readonly image?: string;
  readonly ports?: readonly string[];
  readonly secrets?: readonly string[];
  readonly command?: readonly string[];
  readonly mem_limit?: unknown;
  readonly cpus?: unknown;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly cap_drop?: readonly string[];
  readonly read_only?: boolean;
}
interface Compose {
  readonly services: Readonly<Record<string, Service>>;
  readonly volumes?: Readonly<Record<string, { readonly name?: string }>>;
  readonly secrets?: Readonly<Record<string, { readonly file?: string }>>;
}
const load = (path: string): Compose => yaml.load(readFileSync(path, "utf8")) as Compose;
const overlay = load(OVERLAY);
const standby = load(STANDBY);

const primaryCommand = serviceCommand(OVERLAY, "postgres");
const primary = postgresSettings(primaryCommand);
const standbySettings = postgresSettings(serviceCommand(STANDBY, "standby"));

function bytes(size: string): number {
  const m = /^(\d+)\s*(MB|GB)$/.exec(size);
  if (!m) throw new Error(`unsupported size "${size}"`);
  return Number(m[1]) * (m[2] === "GB" ? GIB : 1024 ** 2);
}

describe("compose.replication.yml (the primary overlay)", () => {
  it("keeps every postgres flag that compose.yml and compose.backup.yml set (a `command` replaces, it does not merge)", () => {
    for (const file of ["compose.yml", "compose.backup.yml"]) {
      const base = postgresSettings(serviceCommand(join(PROD, file), "postgres"));
      expect(base.size, `${file} sets postgres flags`).toBeGreaterThan(0);
      for (const [name, value] of base) expect(primary.get(name), `${file}: ${name}`).toBe(value);
    }
    expect(primaryCommand[0]).toBe("postgres");
  });

  it("archives WAL and keeps the standby's replication prerequisites", () => {
    expect(primary.get("archive_mode")).toBe("on");
    expect(primary.get("archive_command")).toMatch(/pgbackrest .*archive-push %p/);
    expect(primary.get("wal_level")).toBe("replica");
    expect(Number(primary.get("max_wal_senders"))).toBeGreaterThanOrEqual(2);
    expect(Number(primary.get("max_replication_slots"))).toBeGreaterThanOrEqual(1);
  });

  it("bounds what a stalled standby makes the primary retain below the backup sidecar's pg_wal alert", () => {
    const alert = /BACKUP_PG_WAL_ALERT_BYTES:-(\d+)/.exec(
      readFileSync(join(PROD, "compose.backup.yml"), "utf8"),
    );
    expect(alert).not.toBeNull();
    const keep = primary.get("max_slot_wal_keep_size");
    expect(keep).toBeDefined();
    expect(bytes(keep ?? "")).toBeLessThan(Number(alert?.[1]));
  });

  it("turns TLS on with every file coming from a declared secret", () => {
    expect(primary.get("ssl")).toBe("on");
    expect(primary.get("ssl_min_protocol_version")).toBe("TLSv1.3");
    const postgres = overlay.services.postgres;
    for (const setting of ["ssl_cert_file", "ssl_key_file", "ssl_ca_file"]) {
      const path = primary.get(setting) ?? "";
      const name = path.replace("/run/secrets/", "");
      expect(path, setting).toMatch(/^\/run\/secrets\/replication_[a-z_]+$/);
      expect(postgres?.secrets, `${setting} secret mounted`).toContain(name);
      expect(overlay.secrets?.[name]?.file, `${name} declared`).toBe(`./secrets/${name}`);
    }
  });

  it("publishes 5432 only on an address the operator must name, never on every interface", () => {
    const ports = overlay.services.postgres?.ports ?? [];
    expect(ports).toHaveLength(1);
    // `:?` makes the address required (no `:-` default can quietly mean every interface); what follows it is only the port pair.
    expect(ports[0]).toMatch(/^"?\$\{REPLICATION_PUBLISH_ADDR:\?[^}]+\}:5432:5432"?$/);
    expect(ports[0]).not.toContain("REPLICATION_PUBLISH_ADDR:-");
    expect(ports[0]?.replace(/\$\{[^}]*\}/, "")).toBe(":5432:5432");
  });

  it("runs its one-shot and its monitor from the signed backup image, bounded and hardened", () => {
    for (const name of ["replication-provision", "replication-monitor"]) {
      const svc = overlay.services[name];
      expect(svc?.image, name).toBe(BACKUP_IMAGE);
      expect(svc?.mem_limit, `${name} mem_limit`).toBeDefined();
      expect(svc?.cpus, `${name} cpus`).toBeDefined();
      expect(svc?.cap_drop, `${name} cap_drop`).toEqual(["ALL"]);
      expect(svc?.read_only, `${name} read_only`).toBe(true);
      expect(svc?.ports, `${name} ports`).toBeUndefined();
    }
  });

  it("keeps the monitor's state on a named volume, not in tmpfs a restart wipes", () => {
    const monitor = overlay.services["replication-monitor"];
    expect(monitor?.environment?.REPLICATION_STATE_DIR).toBe("/var/lib/cw-backup");
    expect(monitor?.volumes).toContain("replication-state:/var/lib/cw-backup");
    expect(overlay.volumes?.["replication-state"]?.name).toMatch(/_replication-state$/);
  });

  it("makes the alert webhook mandatory for the monitor, like the backup sidecar", () => {
    expect(overlay.services["replication-monitor"]?.environment?.OPS_ALERT_WEBHOOK_URL).toMatch(
      /^\$\{OPS_ALERT_WEBHOOK_URL:\?/,
    );
  });

  it("points every service at a script that exists, and every script parses", () => {
    const scripts = [
      ...(overlay.services["replication-provision"]?.command ?? []),
      ...(overlay.services["replication-monitor"]?.command ?? []),
      ...(standby.services["standby-bootstrap"]?.command ?? []),
    ].filter((c) => c.endsWith(".sh"));
    expect(scripts.length).toBe(3);
    for (const script of scripts) {
      const file = join(REPL, script.split("/").pop() ?? "");
      expect(existsSync(file), script).toBe(true);
      const syntax = spawnSync("bash", ["-n", file], { encoding: "utf8" });
      expect(syntax.status, `${file}: ${syntax.stderr}`).toBe(0);
    }
    const certs = spawnSync("bash", ["-n", join(REPL, "make-certs.sh")], { encoding: "utf8" });
    expect(certs.status, certs.stderr).toBe(0);
  });

  // The CA key can mint a client certificate that reads the whole database: it must not sit in the directory an operator
  // copies to a host (`scp -r ./certs`).
  const hasOpenssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!hasOpenssl)("writes the CA key outside the directory that goes to the hosts", () => {
    const scratch = mkdtempSync(join(tmpdir(), "make-certs-"));
    try {
      const out = join(scratch, "certs");
      const made = spawnSync("bash", [join(REPL, "make-certs.sh"), out, "primary.test", "2"], {
        encoding: "utf8",
      });
      expect(made.status, made.stderr).toBe(0);
      const inOut = readdirSync(out);
      const caKeysInOut = inOut.filter(
        (name) => name.endsWith("ca.key") || name.includes("ca_key"),
      );
      expect(caKeysInOut).toEqual([]);
      for (const name of [
        "replication_ca",
        "replication_server_cert",
        "replication_server_key",
        "replication_client_cert",
        "replication_client_key",
      ]) {
        expect(inOut, name).toContain(name);
      }
      expect(readdirSync(`${out}.ca`)).toEqual(["replication_ca.key"]);
      expect(statSync(join(`${out}.ca`, "replication_ca.key")).mode & 0o777).toBe(0o400);
      expect(made.stdout).toContain(`${out}.ca/replication_ca.key`);
      // a second run must not mint a second CA over the first
      const again = spawnSync("bash", [join(REPL, "make-certs.sh"), out, "primary.test", "2"], {
        encoding: "utf8",
      });
      expect(again.status).not.toBe(0);
      expect(again.stderr).toMatch(/refusing to overwrite/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("is shipped to the host by deploy.yml next to compose.backup.yml, without the CA-key generator", () => {
    // Active lines only: a commented-out scp must not satisfy this.
    const deploy = readFileSync(join(REPO, ".github/workflows/deploy.yml"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    for (const file of [
      "compose.replication.yml",
      "db-replication/provision-primary.sh",
      "db-replication/replication-monitor.sh",
    ]) {
      expect(deploy, file).toContain(file);
    }
    expect(deploy).not.toContain("make-certs.sh");
  });

  it("requires the standby's address for the pg_hba rule and gives the provisioner no network", () => {
    const provision = overlay.services["replication-provision"] as Service & {
      readonly network_mode?: string;
    };
    expect(provision.environment?.REPLICATION_STANDBY_CIDR).toMatch(
      /^\$\{REPLICATION_STANDBY_CIDR:\?/,
    );
    expect(provision.network_mode).toBe("none");
  });
});

describe("db-replication/compose.standby.yml (the standby host)", () => {
  it("never undercuts the primary where a hot standby refuses to start", () => {
    for (const name of ["max_locks_per_transaction", "max_wal_senders"]) {
      expect(standbySettings.get(name), name).toBe(primary.get(name));
    }
  });

  it("never archives and is a hot standby", () => {
    expect(standbySettings.get("archive_mode")).toBe("off");
    expect(standbySettings.get("hot_standby")).toBe("on");
  });

  it("logs every connection to the readable PHI copy (it has no application audit trail)", () => {
    expect(standbySettings.get("log_connections")).toBe("on");
    expect(standbySettings.get("log_disconnections")).toBe("on");
  });

  it("publishes no port and runs every service from the signed backup image, bounded", () => {
    for (const [name, svc] of Object.entries(standby.services)) {
      expect(svc.image, name).toBe(BACKUP_IMAGE);
      expect(svc.mem_limit, `${name} mem_limit`).toBeDefined();
      expect(svc.cpus, `${name} cpus`).toBeDefined();
      expect(svc.ports, `${name} ports`).toBeUndefined();
    }
  });

  it("restores from the READ-ONLY key and declares every secret it mounts as a file", () => {
    const env = standby.services.standby?.environment ?? {};
    expect(env.BACKUP_OFFSITE_S3_ACCESS_KEY).toMatch(/BACKUP_OFFSITE_RESTORE_ACCESS_KEY/);
    expect(env.BACKUP_OFFSITE_S3_SECRET_KEY_FILE).toBe(
      "/run/secrets/backup_offsite_restore_secret_key",
    );
    expect(env.BACKUP_PG_LOCAL_REPO).toBe("none");
    for (const name of standby.services.standby?.secrets ?? []) {
      expect(standby.secrets?.[name]?.file, name).toBe(`./secrets/${name}`);
    }
  });

  it("gets the same slot and role names on both sides", () => {
    for (const env of [
      overlay.services["replication-provision"]?.environment,
      standby.services.standby?.environment,
    ]) {
      expect(env?.REPLICATION_SLOT).toBe("cw_standby");
      expect(env?.REPLICATION_ROLE).toBe("cw_replicator");
    }
  });
});

describe("compose-command", () => {
  it("resolves ${VAR:-default} and refuses any other interpolation", () => {
    expect(resolveDefaults("max_slot_wal_keep_size=${X_Y:-4GB}")).toBe(
      "max_slot_wal_keep_size=4GB",
    );
    expect(() => resolveDefaults("a=${NEEDS_A_VALUE}")).toThrow(/without a default/);
    expect(() => resolveDefaults("a=${NEEDS:?set me}")).toThrow(/without a default/);
  });
});
