/**
 * Agent harness detection rules (scripts/harness/patterns.ts). Each rule is proven both ways: it
 * fires on the shape it exists for, and stays quiet on the look-alike the repo legitimately contains.
 */
import { describe, expect, it } from "vitest";
import {
  classifyBash,
  registryFrom,
  scanContent,
  secretPathReason,
  ssnNeverIssued,
} from "../harness/patterns";

// Fixture values are assembled at runtime so this file does not trip the very scanner it tests
// (the Stop gate and harness:phi-scan read test files too).
const ISSUED_SSN = ["524", "71", "3388"].join("-");
const ISSUED_SSN_RAW = ISSUED_SSN.replace(/-/g, "");
const MBI_PARTS = ["2TW7", "HD4", "KC61"];
const PEM_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "PRIVATE KEY-----"].join(" ");
const AWS_KEY = ["AKIA", "QWERTYUIOPASDFGH"].join("");
const REMOTE_DB_URL = ["postgres://app:Zq8v3LmP0x", "db.prod.example-host.net:5432/cw"].join("@");
const REG = registryFrom({ ssn: ["123-45-6789"], mbi: ["1EG4TE5MK73"] });

describe("secretPathReason", () => {
  it.each([
    ".env",
    "apps/backend/.env.local",
    "deploy/production/.env.production",
    ".env.bak.1730000000",
    "certs/tls.key",
    "x/id_ed25519",
    "db/prod.dump",
    "~/.ssh/config",
    "a/secrets/x.json",
  ])("refuses %s", (p) => expect(secretPathReason(p)).not.toBeNull());
  it.each([
    ".env.example",
    "deploy/production/.env.production.example",
    "deploy/production/.env.tenant.example",
    ".envrc",
    "src/environment.ts",
    "packages/auth/src/keys.ts",
  ])("allows %s", (p) => expect(secretPathReason(p)).toBeNull());
});

describe("scanContent — PHI-shaped identifiers", () => {
  it("flags an SSN that could have been issued", () => {
    const f = scanContent(`const p = { ssn: "${ISSUED_SSN}" };`, REG, "a.test.ts");
    expect(f.map((x) => x.kind)).toEqual(["ssn"]);
    expect(f[0]?.sample).not.toContain("71-33");
  });
  it("allows never-issued SSNs and registry SSNs", () => {
    expect(ssnNeverIssued("900", "12", "3456")).toBe(true);
    expect(scanContent(`"900-12-3456" "000-45-6789" "666-12-3456" "123-45-6789"`, REG)).toEqual([]);
  });
  it("flags a keyed undashed SSN, not other 9-digit numbers", () => {
    expect(scanContent(`ssn: "${ISSUED_SSN_RAW}"`, REG).map((x) => x.kind)).toEqual(["ssn"]);
    expect(scanContent(`npi: "123456789", zip9: "974010000"`, REG)).toEqual([]);
  });
  it("flags an unregistered MBI, dashed or not; allows the CMS example", () => {
    expect(scanContent(`mbi: "${MBI_PARTS.join("")}"`, REG).map((x) => x.kind)).toEqual(["mbi"]);
    expect(scanContent(`mbi: "${MBI_PARTS.join("-")}"`, REG).map((x) => x.kind)).toEqual(["mbi"]);
    expect(scanContent(`mbi: "1EG4TE5MK73" and "1EG4-TE5-MK73"`, REG)).toEqual([]);
  });
  it("does not read lower-case hex or longer tokens as an MBI", () => {
    expect(scanContent(`sha "1eg4te5mk73"  id "X1EG4TE5MK73Y"`, REG)).toEqual([]);
  });
  it("never scans lockfiles or the registry itself", () => {
    expect(scanContent(`"${ISSUED_SSN}"`, REG, "bun.lock")).toEqual([]);
    expect(scanContent(`"${ISSUED_SSN}"`, REG, "compliance/synthetic-identifiers.json")).toEqual(
      [],
    );
  });
});

describe("scanContent — credentials", () => {
  it("flags a real-length private key but not a test stub", () => {
    const body = "A".repeat(300);
    expect(scanContent(`${PEM_BEGIN}\n${body}\n${PEM_END}`, REG).map((x) => x.kind)).toEqual([
      "private-key",
    ]);
    expect(
      scanContent(`"-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----"`, REG),
    ).toEqual([]);
  });
  it("flags AWS keys except AWS's documentation example", () => {
    expect(scanContent(AWS_KEY, REG).map((x) => x.kind)).toEqual(["cloud-key"]);
    expect(scanContent(`AKIAIOSFODNN7EXAMPLE`, REG)).toEqual([]);
  });
  it("flags a postgres URL with a password for a remote host only", () => {
    expect(scanContent(REMOTE_DB_URL, REG).map((x) => x.kind)).toEqual(["db-url-password"]);
    expect(
      scanContent(
        `postgres://chartwarden:chartwarden@localhost:5432/cw postgres://u:pw@postgres:5432/x`,
        REG,
      ),
    ).toEqual([]);
  });
  it("flags a high-entropy SECRET assignment in source, not in tests or placeholders", () => {
    const secret = `${"BETTER_AUTH_SECRET=Xk9#".replace("#", "")}q2Lm8Vb7Nc6Zx5Ty4Ru3Ws2Qe1Pa0Od9`;
    expect(scanContent(secret, REG, "apps/backend/src/x.ts").map((x) => x.kind)).toEqual([
      "high-entropy-secret",
    ]);
    expect(scanContent(secret, REG, "apps/backend/__tests__/x.test.ts")).toEqual([]);
    expect(
      scanContent("BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}", REG, "apps/backend/src/x.ts"),
    ).toEqual([]);
  });
});

describe("classifyBash", () => {
  const d = (cmd: string, branch?: string) => classifyBash(cmd, { branch }).decision;
  it("denies gate bypasses", () => {
    expect(d("git push --no-verify origin feat/x")).toBe("deny");
    expect(d("git commit -m wip --no-verify")).toBe("deny");
    expect(d("SKIP_FITNESS=1 git push")).toBe("deny");
    expect(d("git config core.hooksPath /dev/null")).toBe("deny");
    expect(d("git config core.hooksPath .githooks")).toBe("allow");
  });
  it("denies environment dumps and secret-file reads", () => {
    expect(d("printenv")).toBe("deny");
    expect(d("env | sort")).toBe("deny");
    expect(d("cat .env")).toBe("deny");
    expect(d("grep DATABASE_URL apps/backend/.env.local")).toBe("deny");
    expect(d("cat .env.example")).toBe("allow");
    expect(d("ls -la .env")).toBe("allow");
    expect(d("docker compose --env-file .env up -d")).toBe("allow");
    expect(d("set -euo pipefail; bun run build")).toBe("allow");
  });
  it("denies remote database access, allows local and docker exec", () => {
    expect(d("psql -h db.prod.chartwarden.net -U app")).toBe("deny");
    expect(d("pg_dump postgres://app:x@10.0.0.5.example.org/cw")).toBe("deny");
    expect(d("psql -h localhost -p 55432 -U postgres")).toBe("allow");
    expect(d("psql -h 127.0.0.1 -p 15432")).toBe("allow");
    expect(d("docker exec -it cw-postgres psql -U postgres")).toBe("allow");
  });
  it("asks for remote shells, uploads, live suites and pushes to main", () => {
    expect(d("ssh deploy@203.0.113.10")).toBe("ask");
    expect(d("curl -X POST -d @payload.json https://hooks.example.com/x")).toBe("ask");
    expect(d("curl -s http://localhost:15000/health")).toBe("allow");
    expect(d("bun run test:m4:audit-integrity:live")).toBe("ask");
    expect(d("git push origin main")).toBe("ask");
    expect(d("git push", "main")).toBe("ask");
    expect(d("git push -u origin feat/harness", "feat/harness")).toBe("allow");
    expect(d("git push --force origin main")).toBe("deny");
  });
  it("leaves ordinary development commands alone", () => {
    for (const c of [
      "bun run typecheck",
      "bun run arch:fitness",
      "git diff main...HEAD",
      "rg -n requireAbac apps/backend/src",
      "bunx vitest run scripts/__tests__",
    ]) {
      expect(d(c), c).toBe("allow");
    }
  });
});
describe("classifyBash — review regressions (2026-10-27)", () => {
  const d = (cmd: string, branch?: string, exists?: (p: string) => boolean) =>
    classifyBash(cmd, { branch, exists }).decision;
  it("an existence check does not exempt the rest of the command line", () => {
    expect(d("test -f .env && cat .env")).toBe("deny");
    expect(d("ls .env; cat apps/backend/.env")).toBe("deny");
  });
  it("docker compose --env-file is fine for lifecycle commands, not for config", () => {
    expect(
      d("docker compose --env-file .env.production -f deploy/production/compose.yml config"),
    ).toBe("deny");
    expect(d("docker compose --env-file .env up -d backend")).toBe("allow");
  });
  it("does not read jq filters, JS member access or new key files as secret paths", () => {
    expect(d("jq '.key' package.json")).toBe("allow");
    expect(d(`bun -e "console.log(o.key)"`)).toBe("allow");
    expect(d("openssl genrsa -out tmp.key 2048")).toBe("allow");
    expect(d("cat tls.key", undefined, (p) => p === "tls.key")).toBe("deny");
    expect(d("find . -name '*.bak'")).toBe("allow");
    expect(d("git diff -- apps/backend/src/secrets/x.ts")).toBe("allow");
  });
  it("only asks for ssh/rsync/curl when they are the program, not a search term", () => {
    expect(d("rg -n ssh CLAUDE.md")).toBe("allow");
    expect(d("grep -rn rsync README.md")).toBe("allow");
    expect(d("grep -F curl x.sh")).toBe("allow");
    expect(d("rsync -a dist/ build/")).toBe("allow");
    expect(d("scp dump.tgz deploy@203.0.113.10:/tmp")).toBe("ask");
  });
  it("catches the careless secret shapes", () => {
    expect(d("echo $DATABASE_URL")).toBe("deny");
    expect(d("cat deploy/production/backend.env")).toBe("deny");
    expect(d("git commit -n -m wip")).toBe("deny");
    expect(d("git commit -anm wip")).toBe("deny");
    expect(d('git commit -m "handle -n flag"')).toBe("allow");
    expect(d('psql "$DATABASE_URL" -c "select 1"')).toBe("ask");
  });
  it("reads of hooksPath are fine; pushes to main are caught in every spelling", () => {
    expect(d("git config --get core.hooksPath")).toBe("allow");
    expect(d("git push origin HEAD", "main")).toBe("ask");
    expect(d("git push origin main:main")).toBe("ask");
    expect(d("git push origin +main")).toBe("deny");
  });
  it("treats only dev-style chartwarden values as placeholders", () => {
    const prod = ["postgres://app:chartwardenProdPw", "1.2.3.4.example-host.net/cw"].join("@");
    expect(scanContent(prod, REG).map((x) => x.kind)).toEqual(["db-url-password"]);
    const local = `M34_PROVISION_GATEWAY_TOKEN: chartwarden-local-${"ab12".repeat(12)}`;
    expect(scanContent(local, REG, "docker-compose.yml")).toEqual([]);
  });
  it("never puts any character of a matched identifier in the finding", () => {
    const f = scanContent(`ssn: "${ISSUED_SSN}"`, REG);
    expect(f[0]?.sample).toBe("11 chars");
  });
});
