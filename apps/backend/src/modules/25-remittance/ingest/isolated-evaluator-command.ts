import {
  type KeyObject,
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { ConflictError, DegradedError, NotFoundError, ValidationError } from "@chartwarden/types";
import type { M25WriteActor } from "../routes/actor";
import type { ReturnTypeMedicaidEraReviewWorkflow } from "./medicaid-era-review-service";

export const M25_EVALUATOR_AUDIENCE = "cw-m25-isolated-evaluator";
export const M25_EVALUATOR_ASSERTION_HEADER = "x-cw-m25-command";
export const MAX_EVALUATOR_COMMAND_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EvaluatorCommand =
  | { readonly operation: "evaluate"; readonly artifactId: string; readonly idempotencyKey: string }
  | {
      readonly operation: "note";
      readonly reviewId: string;
      readonly expectedVersion: number;
      readonly reasonCode: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly operation: "transition";
      readonly reviewId: string;
      readonly expectedVersion: number;
      readonly state: "investigating" | "follow_up_required" | "reviewed_not_posted" | "reopened";
      readonly reasonCode: string;
      readonly idempotencyKey: string;
    };

export interface CommandPrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly sessionId: string;
}

const b64 = (value: string | Buffer): string => Buffer.from(value).toString("base64url");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const serializeEvaluatorCommand = (command: EvaluatorCommand): string =>
  JSON.stringify(command);

export function assertEvaluatorCommand(value: unknown): asserts value is EvaluatorCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("invalid evaluator command", []);
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const common = ["idempotencyKey", "operation"];
  if (
    typeof row.idempotencyKey !== "string" ||
    row.idempotencyKey.length < 8 ||
    row.idempotencyKey.length > 128
  )
    throw new ValidationError("invalid evaluator idempotency identity", []);
  if (row.operation === "evaluate") {
    if (
      keys.join() !== [...common, "artifactId"].sort().join() ||
      typeof row.artifactId !== "string" ||
      !UUID.test(row.artifactId)
    )
      throw new ValidationError("invalid evaluate command", []);
    return;
  }
  const expected = [...common, "expectedVersion", "reasonCode", "reviewId"];
  if (row.operation === "transition") expected.push("state");
  if (
    keys.join() !== expected.sort().join() ||
    typeof row.reviewId !== "string" ||
    !UUID.test(row.reviewId) ||
    !Number.isInteger(row.expectedVersion) ||
    Number(row.expectedVersion) < 1 ||
    typeof row.reasonCode !== "string" ||
    !/^[A-Z0-9_]{2,64}$/.test(row.reasonCode)
  )
    throw new ValidationError("invalid evaluator mutation command", []);
  if (row.operation === "note") return;
  if (
    row.operation === "transition" &&
    ["investigating", "follow_up_required", "reviewed_not_posted", "reopened"].includes(
      String(row.state),
    )
  )
    return;
  throw new ValidationError("unsupported evaluator operation", []);
}

export function createEvaluatorCommandSigner(input: {
  kid: string;
  key: KeyObject;
  now?: () => number;
}) {
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const header = b64(JSON.stringify({ alg: "EdDSA", kid: input.kid, typ: "JWT" }));
  return (principal: CommandPrincipal, command: EvaluatorCommand): string => {
    const body = serializeEvaluatorCommand(command);
    const iat = now();
    const payload = b64(
      JSON.stringify({
        iss: "cw-api",
        aud: M25_EVALUATOR_AUDIENCE,
        sub: principal.userId,
        org: principal.organizationId,
        mid: principal.membershipId,
        sid: principal.sessionId,
        op: command.operation,
        bh: digest(body),
        jti: b64(randomBytes(16)),
        iat,
        exp: iat + 30,
      }),
    );
    const signed = `${header}.${payload}`;
    return `${signed}.${b64(sign(null, Buffer.from(signed), input.key))}`;
  };
}

export function verifyEvaluatorCommand(input: {
  assertion: string;
  body: string;
  publicKeys: ReadonlyMap<string, KeyObject>;
  now?: () => number;
}): CommandPrincipal & { operation: EvaluatorCommand["operation"]; jti: string } {
  if (Buffer.byteLength(input.body) > MAX_EVALUATOR_COMMAND_BYTES)
    throw new ValidationError("evaluator command is too large", []);
  const parts = input.assertion.split(".");
  if (parts.length !== 3) throw new ValidationError("invalid evaluator assertion", []);
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  } catch {
    throw new ValidationError("invalid evaluator assertion", []);
  }
  const key = typeof header.kid === "string" ? input.publicKeys.get(header.kid) : undefined;
  if (
    header.alg !== "EdDSA" ||
    header.typ !== "JWT" ||
    !key ||
    !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"))
  )
    throw new ValidationError("invalid evaluator assertion", []);
  const now = (input.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (
    claims.iss !== "cw-api" ||
    claims.aud !== M25_EVALUATOR_AUDIENCE ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.iat > now + 5 ||
    claims.exp < now ||
    claims.exp - claims.iat > 30 ||
    claims.bh !== digest(input.body)
  )
    throw new ValidationError("expired or mismatched evaluator assertion", []);
  for (const keyName of ["sub", "org", "mid", "sid", "op", "jti"])
    if (typeof claims[keyName] !== "string" || !claims[keyName])
      throw new ValidationError("incomplete evaluator assertion", []);
  return {
    userId: claims.sub as string,
    organizationId: claims.org as string,
    membershipId: claims.mid as string,
    sessionId: claims.sid as string,
    operation: claims.op as EvaluatorCommand["operation"],
    jti: claims.jti as string,
  };
}

export interface EvaluatorTransport {
  execute(actor: M25WriteActor, command: EvaluatorCommand): Promise<unknown>;
}

export function createHttpEvaluatorTransport(input: {
  url: string;
  signer: ReturnType<typeof createEvaluatorCommandSigner>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): EvaluatorTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async execute(actor, command) {
      if (!actor.sessionId)
        throw new DegradedError(
          "MEDICAID_ERA_EVALUATOR_AUTHORITY_UNAVAILABLE",
          "the authenticated session identity is unavailable",
        );
      const body = serializeEvaluatorCommand(command);
      let response: Response;
      try {
        response = await fetchImpl(`${input.url}/internal/m25/commands`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [M25_EVALUATOR_ASSERTION_HEADER]: input.signer(
              { ...actor, sessionId: actor.sessionId },
              command,
            ),
          },
          body,
          signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
        });
      } catch {
        throw new DegradedError(
          "MEDICAID_ERA_EVALUATOR_UNAVAILABLE",
          "nonposting review evaluator is unavailable",
        );
      }
      const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 409)
        throw new ConflictError("the review command conflicts with current state");
      // A missing review, or one outside the actor's provider-entity scope, is a 404 here, not an unavailable evaluator.
      if (response.status === 404) throw new NotFoundError("Medicaid ERA review not found");
      if (response.status === 400) throw new ValidationError("the review command is invalid", []);
      if (!response.ok || !result)
        throw new DegradedError(
          "MEDICAID_ERA_EVALUATOR_UNAVAILABLE",
          "nonposting review evaluator refused the command",
        );
      return result;
    },
  };
}

export function bindRemoteEvaluatorWrites(
  local: ReturnTypeMedicaidEraReviewWorkflow,
  transport: EvaluatorTransport,
): ReturnTypeMedicaidEraReviewWorkflow {
  return {
    ...local,
    evaluate: (actor, artifactId, idempotencyKey) =>
      transport.execute(actor, {
        operation: "evaluate",
        artifactId,
        idempotencyKey,
      }) as ReturnTypeMedicaidEraReviewWorkflow["evaluate"] extends (...a: never[]) => infer R
        ? R
        : never,
    addNote: (actor, reviewId, expectedVersion, reasonCode, idempotencyKey) =>
      transport.execute(actor, {
        operation: "note",
        reviewId,
        expectedVersion,
        reasonCode,
        idempotencyKey,
      }) as never,
    transition: (actor, reviewId, expectedVersion, state, reasonCode, idempotencyKey) => {
      if (state === "needs_review")
        throw new ValidationError("needs_review is not an operator disposition", []);
      return transport.execute(actor, {
        operation: "transition",
        reviewId,
        expectedVersion,
        state,
        reasonCode,
        idempotencyKey,
      }) as never;
    },
  };
}

/** Off by default. Production accepts the private key from a secret file mounted on api only. */
export function bindConfiguredRemoteEvaluatorWrites(
  local: ReturnTypeMedicaidEraReviewWorkflow,
  env: Record<string, string | undefined>,
): ReturnTypeMedicaidEraReviewWorkflow {
  if (env.M25_EVALUATOR_ENABLED !== "true") return local;
  const url = env.M25_EVALUATOR_URL;
  const file = env.M25_EVALUATOR_SIGNING_KEY_FILE;
  const kid = env.M25_EVALUATOR_SIGNING_KEY_ID;
  if (!url || !file?.startsWith("/") || !kid)
    throw new Error("M25 evaluator configuration is incomplete");
  const raw = readFileSync(file, "utf8").trim();
  const key = createPrivateKey({
    key: Buffer.from(raw, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("M25 evaluator signing key must be Ed25519");
  return bindRemoteEvaluatorWrites(
    local,
    createHttpEvaluatorTransport({ url, signer: createEvaluatorCommandSigner({ kid, key }) }),
  );
}
