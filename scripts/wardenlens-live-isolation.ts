export const WARDENLENS_TEST_LABEL = "com.chartwarden.test-suite";
export const WARDENLENS_PGDATA_TMPFS = "/var/lib/postgresql";

export function assertLocalDockerEndpoint(endpoint: string): void {
  if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://")) {
    throw new Error("WardenLens isolated runner requires a local Docker daemon endpoint");
  }
}

type PortBinding = { HostIp?: string; HostPort?: string };

export type WardenLensContainerInspection = {
  Id?: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
    Env?: string[] | null;
  };
  HostConfig?: {
    Binds?: string[] | null;
    Mounts?: unknown[] | null;
    Tmpfs?: Record<string, string> | null;
    PortBindings?: Record<string, PortBinding[] | null> | null;
  };
  Mounts?: Array<{ Destination?: string; Type?: string }> | null;
  NetworkSettings?: {
    Ports?: Record<string, PortBinding[] | null> | null;
  };
};

function onePostgresLoopbackBinding(
  ports: Record<string, PortBinding[] | null> | null | undefined,
  allowUnassignedPort = false,
): { host: string; port: number | undefined } | undefined {
  if (!ports || Object.keys(ports).length !== 1) return undefined;
  const bindings = ports["5432/tcp"];
  if (!bindings || bindings.length !== 1) return undefined;
  const binding = bindings[0];
  const port =
    binding?.HostPort === "" && allowUnassignedPort ? undefined : Number(binding?.HostPort);
  if (
    binding?.HostIp !== "127.0.0.1" ||
    (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535))
  ) {
    return undefined;
  }
  return { host: binding.HostIp, port };
}

export function validateWardenLensContainerIsolation(
  container: WardenLensContainerInspection,
  expected: { expectedImage: string; expectedLabel: string },
): { host: string; port: number; pgdata: string } {
  const tmpfs = container.HostConfig?.Tmpfs?.[WARDENLENS_PGDATA_TMPFS];
  const tmpfsOptions = new Set((tmpfs ?? "").split(",").map((part) => part.trim()));
  const pgdataEntries = (container.Config?.Env ?? []).filter((entry) =>
    entry.startsWith("PGDATA="),
  );
  const pgdata = pgdataEntries.length === 1 ? pgdataEntries[0]?.slice("PGDATA=".length) : undefined;
  const pgdataWithinTmpfs =
    pgdata?.startsWith(`${WARDENLENS_PGDATA_TMPFS}/`) === true &&
    pgdata
      .slice(WARDENLENS_PGDATA_TMPFS.length + 1)
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..");
  const configuredPort = onePostgresLoopbackBinding(container.HostConfig?.PortBindings, true);
  const runtimePort = onePostgresLoopbackBinding(container.NetworkSettings?.Ports);
  const mounts = container.Mounts ?? [];

  if (
    !container.Id ||
    container.Config?.Image !== expected.expectedImage ||
    container.Config?.Labels?.[WARDENLENS_TEST_LABEL] !== expected.expectedLabel ||
    !pgdata ||
    !pgdataWithinTmpfs ||
    !tmpfsOptions.has("rw") ||
    !tmpfsOptions.has("noexec") ||
    !tmpfsOptions.has("nosuid") ||
    (container.HostConfig?.Binds?.length ?? 0) !== 0 ||
    (container.HostConfig?.Mounts?.length ?? 0) !== 0 ||
    mounts.length !== 0 ||
    !configuredPort ||
    !runtimePort ||
    configuredPort.host !== runtimePort.host ||
    (configuredPort.port !== undefined && configuredPort.port !== runtimePort.port)
  ) {
    throw new Error(
      "WardenLens Docker isolation preflight failed (expected labeled production-derived image, tmpfs PGDATA, no persistent mounts, and one random loopback PostgreSQL port)",
    );
  }

  return { host: runtimePort.host, port: runtimePort.port as number, pgdata };
}

export function assertFreshWardenLensDatabase(
  databaseNames: readonly string[],
  expectedDatabaseName: string,
): void {
  if (
    databaseNames.length !== 2 ||
    !databaseNames.includes("postgres") ||
    !databaseNames.includes(expectedDatabaseName)
  ) {
    throw new Error(
      `Disposable WardenLens cluster is not fresh (found: ${databaseNames.join(", ") || "none"})`,
    );
  }
}

export type WardenLensDatabaseIdentity = {
  databaseName: string;
  clusterName: string;
  serverVersionNum: number;
  isSuperuser: boolean;
  maxLocksPerTransaction: number;
  systemIdentifier: string;
};

export function assertWardenLensDatabaseIdentity(
  identity: WardenLensDatabaseIdentity,
  expected: { databaseName: string; clusterName: string },
): void {
  if (
    identity.databaseName !== expected.databaseName ||
    identity.clusterName !== expected.clusterName ||
    Math.floor(identity.serverVersionNum / 10_000) !== 18 ||
    identity.isSuperuser !== true ||
    identity.maxLocksPerTransaction !== 1024 ||
    !/^\d+$/.test(identity.systemIdentifier)
  ) {
    throw new Error("Disposable WardenLens PostgreSQL identity preflight failed");
  }
}

export function buildWardenLensSuiteEnvironment(
  host: Readonly<Record<string, string | undefined>>,
  isolated: { databaseUrl: string; privateWorkDir: string },
): Record<string, string> {
  return {
    ...(host.PATH === undefined ? {} : { PATH: host.PATH }),
    HOME: isolated.privateWorkDir,
    TMPDIR: isolated.privateWorkDir,
    NODE_ENV: "test",
    CI: "true",
    CHARTWARDEN_TEST_DATABASE_URL: isolated.databaseUrl,
    CHARTWARDEN_WARDENLENS_ISOLATED_RUN: "true",
  };
}

export function isCompleteWardenLensSuite(input: {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  todo: number;
  exitStatus: number | null;
}): boolean {
  return (
    input.exitStatus === 0 &&
    input.total > 0 &&
    input.passed === input.total &&
    input.failed === 0 &&
    input.pending === 0 &&
    input.todo === 0
  );
}
