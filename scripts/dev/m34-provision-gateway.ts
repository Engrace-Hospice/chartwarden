// DEV-ONLY stand-in for the external M34 tenant provision gateway (deploy/production/PROVISION_GATEWAY.md).
// The client in apps/backend/.../provision-gateway.ts is the contract's authority; this stub only answers what
// local provisioning actually calls:
//   - /notifications/tenant-invitation  logs the accept link (there is no mail transport locally)
//   - /storage/tenant-prefixes          acknowledges; the api/worker create the real MinIO prefixes in-process
// Everything else answers 501 so a local run can never fake key custody or storage destruction.
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";

export interface GatewayRequest {
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

export interface GatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface GatewayDeps {
  readonly token: string;
  readonly log: (line: string) => void;
}

const NOT_IMPLEMENTED_PATHS: ReadonlySet<string> = new Set([
  "/dek/wrap",
  "/dek/unwrap",
  "/storage/tenant-scope/destroy",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function authorized(authorization: string | null, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function ensurePrefixes(body: unknown): GatewayResponse {
  if (!isRecord(body) || !isStringArray(body.prefixes)) {
    return { status: 400, body: { error: "prefixes must be an array of strings" } };
  }
  return { status: 200, body: { prefixesEnsured: body.prefixes } };
}

function deliverInvitation(body: unknown, log: GatewayDeps["log"]): GatewayResponse {
  if (
    !isRecord(body) ||
    typeof body.to !== "string" ||
    typeof body.inviteeFullName !== "string" ||
    typeof body.invitationUrl !== "string"
  ) {
    return { status: 400, body: { error: "to, inviteeFullName and invitationUrl are required" } };
  }
  // The URL carries the raw invitation secret; printing it is acceptable only because this stub is dev-only.
  log(`[dev gateway] invitation for ${body.to} (${body.inviteeFullName}): ${body.invitationUrl}`);
  return { status: 200, body: { accepted: true } };
}

export async function handleGatewayRequest(
  request: GatewayRequest,
  deps: GatewayDeps,
): Promise<GatewayResponse> {
  if (!authorized(request.authorization, deps.token)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (NOT_IMPLEMENTED_PATHS.has(request.path)) {
    return { status: 501, body: { error: `${request.path} is not available in the dev gateway` } };
  }
  switch (request.path) {
    case "/storage/tenant-prefixes":
      return ensurePrefixes(request.body);
    case "/notifications/tenant-invitation":
      return deliverInvitation(request.body, deps.log);
    default:
      return { status: 404, body: { error: "not found" } };
  }
}

const DEFAULT_PORT = 8080;
const MIN_TOKEN_LENGTH = 32;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function startServer(): void {
  const token = process.env.M34_PROVISION_GATEWAY_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`M34_PROVISION_GATEWAY_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const deps: GatewayDeps = { token, log: (line) => console.info(line) };
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    try {
      const result = await handleGatewayRequest(
        {
          path: pathname,
          body: await readJson(req),
          authorization: req.headers.authorization ?? null,
        },
        deps,
      );
      res
        .writeHead(result.status, { "content-type": "application/json" })
        .end(JSON.stringify(result.body));
    } catch (err) {
      // An aborted upload makes `for await (req)` throw; answer 500 rather than crash the dev gateway.
      console.error("[dev gateway] request failed", err);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    }
  }).listen(port, () => console.info(`[dev gateway] listening on :${port}`));
}

if (import.meta.main) startServer();
