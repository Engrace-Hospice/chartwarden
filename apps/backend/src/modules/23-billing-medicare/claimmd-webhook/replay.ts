// apps/backend/src/modules/23-billing-medicare/claimmd-webhook/replay.ts — replay one captured Claim.MD delivery through the REAL
// webhook route, in process (CW-TX-02). Fastify's inject: no socket, no network, no database. The route, its raw-body parser,
// its 1 MiB limit, its signature check and its refusal trace are the production code; only the store behind it is a stub that
// splits the body the way the real store does and keeps nothing. So "would the route accept this delivery, and what would it
// have stored" is answered by the code that will answer it, without changing the receiver.
//
// Used by scripts/claimmd-webhook-replay.ts (an operator checking the first real delivery) and by the route's own tests.
import { type ClaimMdCapture, parseClaimMdDelivery } from "@chartwarden/x12-837-client";
import Fastify from "fastify";
import { applyErrorHandler } from "../../../bootstrap/plugins/error-handler";
import type { ClaimMdReceive, ClaimMdUsage } from "./receipt-store";
import { registerClaimMdWebhookRoutes } from "./routes";

const PATH_BY_USAGE: Readonly<Record<ClaimMdUsage, string>> = {
  test: "/api/v1/webhooks/claimmd/test",
  production: "/api/v1/webhooks/claimmd/production",
};

export interface ClaimMdRouteReplay {
  readonly statusCode: number;
  /** The error envelope's code (`INVALID_SIGNATURE`, `CLAIMMD_WEBHOOK_UNCONFIGURED`, ...), null on success. */
  readonly errorCode: string | null;
  /** The route's `{received: n}`: how many receipts the real store would write (null when it refused). */
  readonly received: number | null;
  /** The route's PHI-free refusal trace, when it wrote one. */
  readonly refusalTrace: {
    readonly verdict: string;
    readonly usage: string;
    readonly bodyBytes: number;
  } | null;
}

/** Which mounted path a capture belongs to; a path that is neither is replayed to the test route and the caller is told. */
export function usageOfCapture(capture: Pick<ClaimMdCapture, "path">): {
  readonly usage: ClaimMdUsage;
  readonly mapped: boolean;
} {
  if (capture.path.endsWith("/webhooks/claimmd/production"))
    return { usage: "production", mapped: false };
  return { usage: "test", mapped: !capture.path.endsWith("/webhooks/claimmd/test") };
}

/** Post the capture's exact bytes and headers to the real route, as if Claim.MD had sent it, in this process. */
export async function replayCaptureThroughRoute(input: {
  readonly capture: ClaimMdCapture;
  readonly rawBody: Buffer;
  readonly accountKey: string;
}): Promise<ClaimMdRouteReplay> {
  const { usage } = usageOfCapture(input.capture);
  const receive: ClaimMdReceive = async ({ rawBody }) => {
    const delivery = parseClaimMdDelivery(rawBody);
    return delivery.kind === "events" ? delivery.events.length : 1;
  };
  const logLines: string[] = [];
  const app = Fastify({
    logger: { level: "warn", stream: { write: (line: string) => void logLines.push(line) } },
  });
  applyErrorHandler(app);
  registerClaimMdWebhookRoutes(app, {
    binding: { usage, accountKey: input.accountKey, receive },
    usage,
  });
  try {
    // content-length is the transport's to compute for the bytes it is given
    const { "content-length": _declared, ...headers } = input.capture.headers;
    const res = await app.inject({
      method: "POST",
      url: PATH_BY_USAGE[usage],
      headers,
      payload: input.rawBody,
    });
    const json = safeJson(res.body);
    return {
      statusCode: res.statusCode,
      errorCode: json?.error?.code ?? null,
      received: typeof json?.received === "number" ? json.received : null,
      refusalTrace: refusalTraceOf(logLines),
    };
  } finally {
    await app.close();
  }
}

interface ReplayJson {
  readonly received?: unknown;
  readonly error?: { readonly code?: string };
  readonly event?: string;
  readonly verdict?: string;
  readonly usage?: string;
  readonly bodyBytes?: number;
}

function safeJson(body: string): ReplayJson | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as ReplayJson) : null;
  } catch {
    return null;
  }
}

function refusalTraceOf(lines: readonly string[]): ClaimMdRouteReplay["refusalTrace"] {
  for (const line of lines) {
    const record = safeJson(line);
    if (record?.event === "claimmd.webhook.refused")
      return {
        verdict: String(record.verdict),
        usage: String(record.usage),
        bodyBytes: Number(record.bodyBytes),
      };
  }
  return null;
}
