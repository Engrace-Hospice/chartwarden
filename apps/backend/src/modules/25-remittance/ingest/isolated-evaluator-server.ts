import type { KeyObject } from "node:crypto";
import type { M25WriteActor } from "../routes/actor";
import {
  type CommandPrincipal,
  type EvaluatorCommand,
  M25_EVALUATOR_ASSERTION_HEADER,
  MAX_EVALUATOR_COMMAND_BYTES,
  assertEvaluatorCommand,
  verifyEvaluatorCommand,
} from "./isolated-evaluator-command";
import type { ReturnTypeMedicaidEraReviewWorkflow } from "./medicaid-era-review-service";

export interface EvaluatorAuthorityResolver {
  resolve(
    principal: CommandPrincipal,
    operation: EvaluatorCommand["operation"],
  ): Promise<M25WriteActor | null>;
}

export function createIsolatedEvaluatorHandler(input: {
  workflow: ReturnTypeMedicaidEraReviewWorkflow;
  authority: EvaluatorAuthorityResolver;
  publicKeys: ReadonlyMap<string, KeyObject>;
  now?: () => number;
  ready?: () => Promise<boolean>;
  maxInFlight?: number;
  maxReplayEntries?: number;
  /** One JSON line per failed command (status and error class only); defaults to console.warn. */
  log?: (line: string) => void;
}) {
  const seen = new Map<string, number>();
  let inFlight = 0;
  const isReady = async () => {
    try {
      return input.ready ? await input.ready() : true;
    } catch {
      return false;
    }
  };
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/ready") {
      const ready = await isReady();
      return Response.json({ ready }, { status: ready ? 200 : 503 });
    }
    if (request.method !== "POST" || path !== "/internal/m25/commands")
      return Response.json({ error: "not_found" }, { status: 404 });
    if (!(await isReady())) return Response.json({ error: "not_ready" }, { status: 503 });
    const maxInFlight = input.maxInFlight ?? 8;
    if (inFlight >= maxInFlight)
      return Response.json({ error: "busy" }, { status: 503, headers: { "retry-after": "1" } });
    inFlight += 1;
    try {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_EVALUATOR_COMMAND_BYTES)
        return Response.json({ error: "command_too_large" }, { status: 413 });
      if (!request.body) return Response.json({ error: "invalid_body" }, { status: 400 });
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          byteLength += value.byteLength;
          if (byteLength > MAX_EVALUATOR_COMMAND_BYTES) {
            await reader.cancel();
            return Response.json({ error: "command_too_large" }, { status: 413 });
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let body: string;
      try {
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return Response.json({ error: "invalid_body" }, { status: 400 });
      }
      const assertion = request.headers.get(M25_EVALUATOR_ASSERTION_HEADER) ?? "";
      const principal = verifyEvaluatorCommand({
        assertion,
        body,
        publicKeys: input.publicKeys,
        now: input.now,
      });
      const command: unknown = JSON.parse(body);
      assertEvaluatorCommand(command);
      if (principal.operation !== command.operation)
        return Response.json({ error: "operation_mismatch" }, { status: 401 });
      const now = (input.now ?? (() => Math.floor(Date.now() / 1000)))();
      for (const [jti, expiry] of seen) if (expiry < now) seen.delete(jti);
      if (seen.has(principal.jti))
        return Response.json({ error: "assertion_replayed" }, { status: 409 });
      if (seen.size >= (input.maxReplayEntries ?? 10_000))
        return Response.json({ error: "replay_cache_busy" }, { status: 503 });
      seen.set(principal.jti, now + 30);
      const actor = await input.authority.resolve(principal, command.operation);
      if (!actor) return Response.json({ error: "authority_denied" }, { status: 403 });
      let result: unknown;
      if (command.operation === "evaluate")
        result = await input.workflow.evaluate(actor, command.artifactId, command.idempotencyKey);
      else if (command.operation === "note")
        result = await input.workflow.addNote(
          actor,
          command.reviewId,
          command.expectedVersion,
          command.reasonCode,
          command.idempotencyKey,
        );
      else
        result = await input.workflow.transition(
          actor,
          command.reviewId,
          command.expectedVersion,
          command.state,
          command.reasonCode,
          command.idempotencyKey,
        );
      return Response.json(result);
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const status =
        name === "ConflictError"
          ? 409
          : name === "ValidationError"
            ? 400
            : name === "NotFoundError"
              ? 404
              : 503;
      // Status and error class only: no command body, id or message, which can name a review or an account.
      (input.log ?? ((line: string) => console.warn(line)))(
        JSON.stringify({ event: "m25.evaluator.command_failed", status, errorName: name }),
      );
      return Response.json({ error: status === 503 ? "evaluator_failed" : name }, { status });
    } finally {
      inFlight -= 1;
    }
  };
}
