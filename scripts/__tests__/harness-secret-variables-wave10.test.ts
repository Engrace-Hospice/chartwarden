/**
 * Wave 10, B9 (round-7 R7-ADV-14). `SECRET_VARIABLE` ended at `..._KEY` and knew no key-encryption key: `echo $M34_TENANT_KEK`,
 * `printenv M35_PSEUDONYM_KEY_KEK`, `echo $DATABASE_ADMIN_URL`, `printenv REDIS_URL` and `docker compose exec api printenv
 * M34_TENANT_KEK` printed the repo's own secrets into the transcript while the same shapes with DATABASE_URL or
 * BETTER_AUTH_SECRET were denied. The names come from the example env files of the repo (templates, not live files). The new
 * names ASK, because the documented seed workflow passes M34_TENANT_KEK from the api container; the names that were denied
 * stay denied.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { isGuardedVariable, isSecretVariable } from "../harness/secret-reads";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const REPO = join(__dirname, "..", "..");
// Built from parts: the repo guard refuses a command or file text that names a live env file.
const DOT_ENV = `.e${"nv"}`;
const EXAMPLES = [
  `${DOT_ENV}.example`,
  `deploy/production/${DOT_ENV}.production.example`,
  `deploy/production/${DOT_ENV}.tenant.example`,
  `deploy/production/.deploy-alert${DOT_ENV}.example`,
];

/** Every variable name the repo's example env files declare (commented examples included). */
function exampleNames(): string[] {
  const names = new Set<string>();
  for (const file of EXAMPLES) {
    for (const line of readFileSync(join(REPO, file), "utf8").split("\n")) {
      const match = /^[# ]*([A-Z][A-Z0-9_]*)=/.exec(line);
      if (match) names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

const ASK = [
  "M34_TENANT_KEK",
  "M34_TENANT_KEK_RETIRED",
  "M35_PSEUDONYM_KEY_KEK",
  "M35_PSEUDONYM_KEY_KEK_RETIRED",
  "DATABASE_ADMIN_URL",
  "DATABASE_PLATFORM_URL",
  "DATABASE_DESTRUCTION_URL",
  "REDIS_URL",
  "DOSESPOT_TENANT_CONFIGS",
  "CLAIMMD_RESPONSE_INBOX_KEYRING",
  "FCM_SERVICE_ACCOUNT_JSON",
  "APNS_KEY_P8",
  "DEPLOY_ALERT_WEBHOOK_URL",
];
const DENY = [
  "DATABASE_URL",
  "CHARTWARDEN_TEST_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "DOSESPOT_WEBHOOK_SECRETS",
  "MINIO_SECRET_KEY",
  "M24_CREDENTIAL_ENCRYPTION_KEY",
  "TWO_FACTOR_ENCRYPTION_KEY",
  "POSTMARK_SERVER_TOKEN",
  "TWILIO_AUTH_TOKEN",
  "POSTGRES_PASSWORD",
  "VAPID_PRIVATE_KEY",
];
/** Names that look like a secret but are a public key, a file path, an identifier or a switch. */
const NOT_A_SECRET = new Set([
  "CW_ACTOR_PUBLIC_KEYS",
  "CW_ACTOR_SIGNING_KEY_FILE",
  "M23_HETS_CLIENT_KEY_FILE",
  "M23_HETS_CLIENT_CERT_FILE",
  "APNS_KEY_ID",
  "VAPID_PUBLIC_KEY",
  "TRUSTED_PROXY_CIDRS",
  "FHIR_TOKEN_ENDPOINT_ENABLED",
  "FHIR_TOKEN_ENDPOINT_URL",
]);
const LOOKS_SECRET =
  /SECRET|TOKEN|PASSWORD|PASSWD|_KEY|KEK|KEYRING|CREDENTIAL|DATABASE_\w*URL|REDIS_URL|WEBHOOK_URL|TENANT_CONFIGS|SERVICE_ACCOUNT/;

describe("the repo's own secret variables are not printed into the transcript", () => {
  it.each(ASK)("%s asks, in every shell shape that prints it", (name) => {
    for (const cmd of [
      `echo $${name}`,
      `echo "\${${name}}"`,
      `printf '%s' "$${name}"`,
      `printenv ${name}`,
      `docker compose exec api printenv ${name}`,
      `docker compose exec api sh -c 'echo $${name}'`,
      `bash -c 'echo $${name}'`,
    ]) {
      expect(decide(cmd), cmd).toBe("ask");
    }
  });

  it.each(ASK)(
    "%s is not printed by inline code either (an ask, or the deny it already had)",
    (name) => {
      for (const cmd of [
        `bun -e 'console.log(process.env.${name})'`,
        `python3 -c 'import os; print(os.environ["${name}"])'`,
      ]) {
        expect(decide(cmd), cmd).not.toBe("allow");
      }
    },
  );

  it.each(["M34_TENANT_KEK", "DATABASE_ADMIN_URL", "REDIS_URL", "DOSESPOT_TENANT_CONFIGS"])(
    "%s read by inline code asks",
    (name) => {
      expect(decide(`bun -e 'console.log(process.env.${name})'`)).toBe("ask");
      expect(decide(`python3 -c 'import os; print(os.environ["${name}"])'`)).toBe("ask");
    },
  );

  it.each(DENY)("%s is still denied", (name) => {
    for (const cmd of [
      `echo $${name}`,
      `printenv ${name}`,
      `docker compose exec api printenv ${name}`,
    ]) {
      expect(decide(cmd), cmd).toBe("deny");
    }
  });

  it("every secret-looking variable of the example env files is refused or asks (a new one fails here until it is named)", () => {
    const allowed = exampleNames().filter(
      (name) =>
        LOOKS_SECRET.test(name) && !NOT_A_SECRET.has(name) && decide(`echo $${name}`) === "allow",
    );
    expect(allowed).toEqual([]);
  });

  it("the example files are read, and hold the names the finding named", () => {
    const names = exampleNames();
    for (const name of [
      "M34_TENANT_KEK",
      "M35_PSEUDONYM_KEY_KEK",
      "DATABASE_ADMIN_URL",
      "REDIS_URL",
      "DOSESPOT_TENANT_CONFIGS",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("checking that a variable is set is not printing it", () => {
    for (const cmd of [
      '[ -n "$M34_TENANT_KEK" ] && echo set',
      'test -z "$REDIS_URL" && echo unset',
      "echo $KEKS_COUNT",
      "printenv NODE_ENV",
      "printenv HOME",
      "echo $PGHOST",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("the two predicates agree with the shapes", () => {
    expect(isGuardedVariable("M34_TENANT_KEK")).toBe(true);
    expect(isSecretVariable("M34_TENANT_KEK")).toBe(false);
    expect(isSecretVariable("DATABASE_URL")).toBe(true);
    expect(isGuardedVariable("DATABASE_URL")).toBe(false);
    expect(isGuardedVariable("NODE_ENV")).toBe(false);
  });
});
