// apps/backend/src/modules/34-saas-tenant-platform/provision-gateway.ts — the HTTP client for the
// EXTERNAL tenant provision gateway (ADR-0038 §3: KEK custody is a port, and binding a production KMS
// is integration work). This file is the AUTHORITY on that service's contract; the operator-facing
// derivation lives at deploy/production/PROVISION_GATEWAY.md and is stale if the two disagree.
//
// No unit in deploy/production/compose.yml provides this service — its `provision` service is an
// unrelated one-shot DB role provisioner that happens to share the word (#115).
import type { M34WorkerDeps } from "./jobs/saas-jobs";

type ProvisionCapability = NonNullable<M34WorkerDeps["provision"]>;
type GatewayPath =
  | "/dek/wrap"
  | "/dek/unwrap"
  | "/storage/tenant-prefixes"
  | "/storage/tenant-scope/destroy"
  | "/notifications/tenant-invitation";

export interface M34ProvisionGatewayConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly invitationAcceptBaseUrl: string;
  readonly timeoutMs: number;
}

export interface M34ProvisionGatewayHttpPort {
  request(input: {
    readonly path: GatewayPath;
    readonly body: unknown;
    readonly config: M34ProvisionGatewayConfig;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
}

const liveHttp: M34ProvisionGatewayHttpPort = {
  async request(input) {
    const response = await fetch(`${input.config.baseUrl.replace(/\/$/, "")}${input.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.config.bearerToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.config.timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Operation-specific validation below rejects an empty/malformed body.
    }
    return { status: response.status, body };
  },
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function call(
  http: M34ProvisionGatewayHttpPort,
  config: M34ProvisionGatewayConfig,
  path: GatewayPath,
  body: unknown,
): Promise<unknown> {
  const response = await http.request({ path, body, config });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`tenant provision gateway returned HTTP ${response.status}`);
  }
  return response.body;
}

export interface M34ProvisionGateway
  extends Pick<ProvisionCapability, "keyMaterial" | "storage" | "invitation"> {
  readonly kekUnwrap: {
    unwrap(input: {
      readonly kekWrappedCiphertext: Buffer;
      readonly kekId: string;
    }): Promise<Buffer>;
  };
  readonly destructionStorage: {
    destroyTenantScope(input: {
      readonly organizationId: string;
    }): Promise<{ readonly prefix: string; readonly objectsDeleted: number }>;
  };
}

export function createM34ProvisionGateway(
  config: M34ProvisionGatewayConfig,
  http: M34ProvisionGatewayHttpPort = liveHttp,
): M34ProvisionGateway {
  return {
    keyMaterial: {
      async mintAndWrapDek(input) {
        const body = await call(http, config, "/dek/wrap", input);
        if (
          !record(body) ||
          typeof body.wrappedCiphertextB64 !== "string" ||
          body.wrappedCiphertextB64.length === 0 ||
          typeof body.kekId !== "string" ||
          body.kekId.length === 0
        ) {
          throw new Error("tenant provision gateway returned invalid wrapped key material");
        }
        return { wrappedCiphertextB64: body.wrappedCiphertextB64, kekId: body.kekId };
      },
    },
    kekUnwrap: {
      async unwrap(input) {
        const body = await call(http, config, "/dek/unwrap", {
          wrappedCiphertextB64: input.kekWrappedCiphertext.toString("base64"),
          kekId: input.kekId,
        });
        if (!record(body) || typeof body.plaintextDekB64 !== "string") {
          throw new Error("tenant key gateway returned invalid unwrapped key material");
        }
        const dek = Buffer.from(body.plaintextDekB64, "base64");
        if (dek.length !== 32) {
          dek.fill(0);
          throw new Error("tenant key gateway returned a DEK that is not 256 bits");
        }
        return dek;
      },
    },
    storage: {
      async ensureTenantPrefixes(input) {
        const body = await call(http, config, "/storage/tenant-prefixes", input);
        if (
          !record(body) ||
          !Array.isArray(body.prefixesEnsured) ||
          !body.prefixesEnsured.every((prefix) => typeof prefix === "string")
        ) {
          throw new Error("tenant provision gateway returned invalid storage confirmation");
        }
        const confirmed = new Set(body.prefixesEnsured);
        if (!input.prefixes.every((prefix) => confirmed.has(prefix))) {
          throw new Error("tenant provision gateway did not confirm every required storage prefix");
        }
        return { prefixesEnsured: body.prefixesEnsured };
      },
    },
    invitation: {
      acceptBaseUrl: config.invitationAcceptBaseUrl,
      async send(input) {
        const body = await call(http, config, "/notifications/tenant-invitation", input);
        if (!record(body) || body.accepted !== true) {
          throw new Error("tenant provision gateway did not accept the invitation delivery");
        }
      },
    },
    destructionStorage: {
      async destroyTenantScope(input) {
        const expectedPrefix = `tenants/${input.organizationId}/`;
        const body = await call(http, config, "/storage/tenant-scope/destroy", {
          organizationId: input.organizationId,
          expectedPrefix,
          includeVersionsAndDeleteMarkers: true,
        });
        if (
          !record(body) ||
          body.prefix !== expectedPrefix ||
          !Number.isSafeInteger(body.objectsDeleted) ||
          (body.objectsDeleted as number) < 0
        ) {
          throw new Error("tenant provision gateway returned invalid storage destruction receipt");
        }
        return { prefix: expectedPrefix, objectsDeleted: body.objectsDeleted as number };
      },
    },
  };
}

export function m34ProvisionGatewayConfigFromEnv(
  env: NodeJS.ProcessEnv,
): M34ProvisionGatewayConfig | null {
  const baseUrl = env.M34_PROVISION_GATEWAY_URL?.trim();
  const bearerToken = env.M34_PROVISION_GATEWAY_TOKEN?.trim();
  const invitationAcceptBaseUrl = env.M34_INVITATION_ACCEPT_URL?.trim();
  if (!baseUrl || !bearerToken || !invitationAcceptBaseUrl) return null;
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" && env.NODE_ENV === "production") {
    throw new Error("M34_PROVISION_GATEWAY_URL must use https in production");
  }
  const timeoutMs = Number(env.M34_PROVISION_GATEWAY_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("M34_PROVISION_GATEWAY_TIMEOUT_MS must be an integer from 1000 through 120000");
  }
  return { baseUrl, bearerToken, invitationAcceptBaseUrl, timeoutMs };
}
