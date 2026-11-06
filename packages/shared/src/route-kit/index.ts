// @chartwarden/shared/route-kit — the one backend route kit (actor, mutation preconditions, signed
// pagination, TypeBox formats, database-result helpers). Every module imports it; no module keeps a copy.
import type { FastifyReply, FastifyRequest } from "fastify";

/** A Fastify pre-handler; `@chartwarden/auth` guards are cast to it (`requirePermission(k) as PreHandler`). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export * from "./abac";
export * from "./actor";
export * from "./concurrency";
export * from "./db-errors";
export * from "./formats";
export * from "./pagination";
