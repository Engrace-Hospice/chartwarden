// apps/backend/src/bootstrap/rust-bridge/config.ts — CW-RUST-M02 P1: configuration of the Bun→Rust bridge.
//
// Everything is OFF by default. With no RUST_* variables set the bridge forwards nothing, signs nothing and runs no
// sweep, so merging P1 changes no runtime behaviour. The spec is chartwarden-rust `docs/CW-RUST-M02.md` v0.3.
//
// Fail closed: turning a route or the sweep on without a signing key or a socket path is a boot error, never a
// silent no-op, and an unknown route name or mode is refused (a typo must not look like "on").
import { type KeyObject, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
/** Same shape as `EnvLike` in ../env.ts, declared here because env.ts imports this module (no import cycle). */
type EnvLike = Record<string, string | undefined>;

/** Routes the bridge knows how to forward. M02 has exactly one. */
export const RUST_BRIDGE_ROUTES = {
  "me-permissions": { method: "GET", path: "/api/v1/me/permissions" },
} as const;
export type RustBridgeRoute = keyof typeof RUST_BRIDGE_ROUTES;

export type RustRouteMode = "shadow" | "serve";

export interface RustBridgeConfig {
  readonly routes: ReadonlySet<RustBridgeRoute>;
  readonly mode: RustRouteMode;
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly sweepEnabled: boolean;
  /** Daily sweep time, HH:MM UTC (default 10:17 = 03:17 Pacific daylight time). */
  readonly sweepAtUtc: string;
  /** Present only when a route or the sweep is enabled. */
  readonly signingKey: { readonly kid: string; readonly key: KeyObject } | null;
}

export const RUST_BRIDGE_DEFAULTS = {
  socketPath: "/run/cw-rust/cw-rust.sock",
  timeoutMs: 300,
  sweepAtUtc: "10:17",
} as const;

export class RustBridgeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Rust bridge configuration: ${problems.join("; ")}`);
    this.name = "RustBridgeConfigError";
  }
}

const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The signing key is `kid=<base64url PKCS#8 DER Ed25519 private key>`, read from the file named by
 * `CW_ACTOR_SIGNING_KEY_FILE` (production: a compose secret mounted on `api` ONLY) or, for local development, from
 * `CW_ACTOR_SIGNING_KEY`. It must never be put in `.env.production`: that file is injected into seven containers.
 * The value is never logged and never echoed in an error (problems name the variable, not its content).
 */
function parseSigningKey(
  raw: string | undefined,
  problems: string[],
): RustBridgeConfig["signingKey"] {
  if (!raw) {
    if (
      !problems.some((p) => p.startsWith("CW_ACTOR_SIGNING_KEY") || p.startsWith("set CW_ACTOR"))
    ) {
      problems.push(
        "CW_ACTOR_SIGNING_KEY is required when a Rust route or the parity sweep is enabled",
      );
    }
    return null;
  }
  const eq = raw.indexOf("=");
  const kid = eq > 0 ? raw.slice(0, eq) : "";
  if (!KID_RE.test(kid)) {
    problems.push("CW_ACTOR_SIGNING_KEY must be kid=<base64url PKCS#8 Ed25519 key>");
    return null;
  }
  // Strict base64url: Node's decoder silently ignores stray trailing characters, so a corrupted or truncated paste
  // could still load. Require the value to round-trip exactly.
  const encoded = raw.slice(eq + 1);
  const der = Buffer.from(encoded, "base64url");
  if (der.length === 0 || der.toString("base64url") !== encoded) {
    problems.push(
      "CW_ACTOR_SIGNING_KEY is not a valid PKCS#8 private key (not canonical base64url)",
    );
    return null;
  }
  try {
    const key = createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "ed25519") {
      problems.push("CW_ACTOR_SIGNING_KEY is not an Ed25519 private key");
      return null;
    }
    return { kid, key };
  } catch {
    problems.push("CW_ACTOR_SIGNING_KEY is not a valid PKCS#8 private key");
    return null;
  }
}

export interface ParseOptions {
  /** Reads CW_ACTOR_SIGNING_KEY_FILE. Default: fs.readFileSync. */
  readonly readFile?: (path: string) => string;
  /**
   * false = validate structure only and do not load the key (deploy-time validation runs in a container that does
   * not mount the key file). Default true.
   */
  readonly loadKey?: boolean;
}

function keySource(env: EnvLike, opts: ParseOptions, problems: string[]): string | undefined {
  const file = env.CW_ACTOR_SIGNING_KEY_FILE;
  if (file && env.CW_ACTOR_SIGNING_KEY) {
    problems.push("set CW_ACTOR_SIGNING_KEY_FILE or CW_ACTOR_SIGNING_KEY, not both");
    return undefined;
  }
  if (!file) return env.CW_ACTOR_SIGNING_KEY;
  if (!file.startsWith("/")) {
    problems.push("CW_ACTOR_SIGNING_KEY_FILE must be an absolute path");
    return undefined;
  }
  try {
    return (opts.readFile ?? ((p: string) => readFileSync(p, "utf8")))(file).trim();
  } catch {
    problems.push("CW_ACTOR_SIGNING_KEY_FILE cannot be read");
    return undefined;
  }
}

export function parseRustBridgeConfig(env: EnvLike, opts: ParseOptions = {}): RustBridgeConfig {
  const problems: string[] = [];

  const routes = new Set<RustBridgeRoute>();
  for (const name of (env.RUST_ROUTES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (name in RUST_BRIDGE_ROUTES) routes.add(name as RustBridgeRoute);
    else problems.push(`RUST_ROUTES names an unknown route: ${JSON.stringify(name)}`);
  }

  const modeRaw = env.RUST_ROUTE_MODE ?? "shadow";
  if (modeRaw !== "shadow" && modeRaw !== "serve")
    problems.push(`RUST_ROUTE_MODE must be shadow or serve`);
  const mode: RustRouteMode = modeRaw === "serve" ? "serve" : "shadow";

  const sweepRaw = env.RUST_PARITY_SWEEP ?? "off";
  if (sweepRaw !== "on" && sweepRaw !== "off") problems.push("RUST_PARITY_SWEEP must be on or off");
  const sweepEnabled = sweepRaw === "on";

  const sweepAtUtc = env.RUST_PARITY_SWEEP_UTC ?? RUST_BRIDGE_DEFAULTS.sweepAtUtc;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sweepAtUtc))
    problems.push("RUST_PARITY_SWEEP_UTC must be HH:MM (UTC)");

  const socketPath = env.RUST_SOCKET ?? RUST_BRIDGE_DEFAULTS.socketPath;
  if (!socketPath.startsWith("/")) problems.push("RUST_SOCKET must be an absolute path");

  const timeoutRaw = env.RUST_TIMEOUT_MS ?? String(RUST_BRIDGE_DEFAULTS.timeoutMs);
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000) {
    problems.push("RUST_TIMEOUT_MS must be an integer between 10 and 5000");
  }

  const active = routes.size > 0 || sweepEnabled;
  let signingKey: RustBridgeConfig["signingKey"] = null;
  if (active && opts.loadKey === false) {
    if (!env.CW_ACTOR_SIGNING_KEY_FILE && !env.CW_ACTOR_SIGNING_KEY) {
      problems.push(
        "CW_ACTOR_SIGNING_KEY_FILE is required when a Rust route or the parity sweep is enabled",
      );
    }
  } else if (active) {
    signingKey = parseSigningKey(keySource(env, opts, problems), problems);
  }

  if (problems.length) throw new RustBridgeConfigError(problems);
  return { routes, mode, socketPath, timeoutMs, sweepEnabled, sweepAtUtc, signingKey };
}

/** True when the bridge does anything at all. */
export function rustBridgeActive(c: RustBridgeConfig): boolean {
  return c.routes.size > 0 || c.sweepEnabled;
}

/**
 * Deploy-time check (called from assertProductionEnv, which deploy.sh runs before migrating): the same structural
 * rules as boot, without loading the key, so a typo in RUST_ROUTES fails the deploy before anything changes instead
 * of crash-looping `api` after the recreate. Returns problem strings; empty = OK.
 */
export function rustBridgeEnvProblems(env: EnvLike): string[] {
  try {
    parseRustBridgeConfig(env, { loadKey: false });
    return [];
  } catch (e) {
    return e instanceof RustBridgeConfigError
      ? [...e.problems]
      : ["Rust bridge configuration is invalid"];
  }
}
