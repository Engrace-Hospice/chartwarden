import { requirePermission } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CompleteVerifiedUploadRequest,
  InitiateVerifiedUploadRequest,
  VerifiedUploadParamsSchema,
  parse,
} from "./documents-typebox";
import type { VerifiedUploadService } from "./verified-upload";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  membershipId: string;
} {
  const ctx = request.context;
  const membershipId = ctx?.attributes?.membershipId;
  if (!ctx?.organizationId || !ctx.userId || typeof membershipId !== "string") {
    throw new UnauthorizedError();
  }
  return { organizationId: ctx.organizationId, userId: ctx.userId, membershipId };
}

const UPLOAD = requirePermission("documents.upload") as PreHandler;

export function registerVerifiedUploadRoutes(
  app: FastifyInstance,
  service: VerifiedUploadService,
): void {
  app.post("/api/v1/document-uploads", { preHandler: [UPLOAD] }, async (request, reply) => {
    const actor = actorOf(request);
    const body = parse(InitiateVerifiedUploadRequest, request.body);
    const result = await service.initiate({
      ...actor,
      input: {
        mode: body.mode,
        targetDocumentId: body.targetDocumentId ?? null,
        patientId: body.patientId ?? null,
        admissionId: body.admissionId ?? null,
        retentionClass: body.retentionClass,
        aggregateType: body.aggregateType,
        aggregateId: body.aggregateId ?? null,
        title: body.title,
        patientFacing: body.patientFacing ?? false,
        mimeType: body.mimeType,
        byteSize: body.byteSize,
        sha256Hex: body.sha256Hex,
        sourceMetadata: body.sourceMetadata,
      },
    });
    return reply.code(201).send(result);
  });

  app.post("/api/v1/document-uploads/:id/complete", { preHandler: [UPLOAD] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(VerifiedUploadParamsSchema, request.params);
    parse(CompleteVerifiedUploadRequest, request.body ?? {});
    return service.complete({ ...actor, uploadId: id });
  });

  app.delete("/api/v1/document-uploads/:id", { preHandler: [UPLOAD] }, async (request, reply) => {
    const actor = actorOf(request);
    const { id } = parse(VerifiedUploadParamsSchema, request.params);
    await service.abort({ ...actor, uploadId: id });
    return reply.code(200).send({ aborted: true });
  });
}
