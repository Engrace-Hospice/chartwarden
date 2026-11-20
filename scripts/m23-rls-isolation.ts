import { type Server, type Socket, createConnection, createServer, isIPv4 } from "node:net";

type DockerMount = { Destination?: string; Type?: string };

export type M23ContainerInspection = {
  Id?: string;
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null };
  HostConfig?: {
    Binds?: string[] | null;
    Mounts?: unknown[] | null;
    Tmpfs?: Record<string, string> | null;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
  Mounts?: DockerMount[] | null;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string; IPAddress?: string }> | null;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
};

export type M23NetworkInspection = {
  Id?: string;
  Name?: string;
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, { IPv4Address?: string }> | null;
};

export const M23_PGDATA_TMPFS = "/var/lib/postgresql";
const M23_TEST_LABEL = "com.chartwarden.test-suite";
const M23_TEST_LABEL_VALUE = "m23-rls-live";

/** Refuses a pre-populated disposable cluster before the live suite can run. */
export function assertFreshM23DatabaseInventory(
  databaseNames: readonly string[],
  expectedDatabaseName: string,
): void {
  if (
    databaseNames.length !== 2 ||
    !databaseNames.includes("postgres") ||
    !databaseNames.includes(expectedDatabaseName)
  ) {
    throw new Error(
      `Disposable cluster is not fresh (expected only postgres and the test database; found: ${databaseNames.join(", ") || "none"})`,
    );
  }
}

/** Requires a complete, non-empty Vitest run with no failure, pending, or todo cases. */
export function isCompleteM23Qualification(input: {
  exitStatus: number | null;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  todo: number;
}): boolean {
  return (
    input.exitStatus === 0 &&
    input.total > 0 &&
    input.failed === 0 &&
    input.pending === 0 &&
    input.todo === 0 &&
    input.passed === input.total
  );
}

export function isM23SuiteEntirelySkipped(input: {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  todo: number;
}): boolean {
  return (
    input.total > 0 &&
    input.passed === 0 &&
    input.failed === 0 &&
    input.pending === input.total &&
    input.todo === 0
  );
}

/** Emits only allowlisted diagnostic facts, never arbitrary Vitest error text. */
export function summarizeVitestFailureMessage(message: string): string[] {
  const summary = new Set<string>();
  if (message.includes("M23 isolated runner did not provide CHARTWARDEN_TEST_DATABASE_URL")) {
    summary.add("Isolated runner database URL missing from Vitest environment");
  }
  const timeout = message.match(/Hook timed out (?:in|after) (\d{1,7})ms/i);
  if (timeout?.[1]) summary.add(`Hook timeout: ${timeout[1]}ms`);

  const errorClass = message.match(
    /(?:^|\n)\s*(?:Caused by:\s*)?([A-Za-z][A-Za-z0-9]*(?:Error|Exception)|Error):/,
  );
  const safeErrorClasses = new Set([
    "Error",
    "AssertionError",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "AggregateError",
    "TimeoutError",
  ]);
  if (errorClass?.[1] && safeErrorClasses.has(errorClass[1])) {
    summary.add(`Failure class: ${errorClass[1]}`);
  }

  const sourceLines = [...message.matchAll(/m23-rls-isolation\.live\.test\.ts:(\d+)(?::\d+)?/g)];
  for (const [, line] of sourceLines.slice(0, 3)) {
    if (line) summary.add(`M23 suite source line: ${line}`);
  }

  if (summary.size === 0) summary.add("No allowlisted failure detail; raw diagnostic withheld.");
  return [...summary];
}

function hasNoPublishedPorts(
  ports: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null | undefined,
): boolean {
  return !ports || Object.values(ports).every((bindings) => !bindings || bindings.length === 0);
}

function hasOnlyExpectedTmpfsMounts(mounts: DockerMount[] | null | undefined): boolean {
  if (!mounts || mounts.length === 0) return true;
  return (
    mounts.length === 1 &&
    mounts[0]?.Type === "tmpfs" &&
    mounts[0]?.Destination === M23_PGDATA_TMPFS
  );
}

function isPrivateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31)
  );
}

/** Docker 29 reports CLI --tmpfs in HostConfig.Tmpfs; Mounts may legitimately be empty. */
export function validateM23DockerIsolation(input: {
  container: M23ContainerInspection;
  network: M23NetworkInspection;
  expectedNetwork: string;
}): string {
  const { container, network, expectedNetwork } = input;
  const id = container.Id;
  const tmpfsOptions = container.HostConfig?.Tmpfs?.[M23_PGDATA_TMPFS];
  const tmpfsTokens = new Set((tmpfsOptions ?? "").split(",").map((token) => token.trim()));
  const pgdataEntries = (container.Config?.Env ?? []).filter((entry) =>
    entry.startsWith("PGDATA="),
  );
  const pgdata = pgdataEntries.length === 1 ? pgdataEntries[0]?.slice("PGDATA=".length) : undefined;
  const pgdataRelative = pgdata?.startsWith(`${M23_PGDATA_TMPFS}/`)
    ? pgdata.slice(M23_PGDATA_TMPFS.length + 1).split("/")
    : undefined;
  const pgdataIsWithinTmpfs =
    !!pgdataRelative?.length &&
    pgdataRelative.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  const containerNetworks = container.NetworkSettings?.Networks ?? {};
  const networkNames = Object.keys(containerNetworks);
  const networkContainers = network.Containers ?? {};
  const members = Object.keys(networkContainers);
  const networkAddress = id ? networkContainers[id]?.IPv4Address?.split("/")[0] : undefined;
  const containerNetwork = containerNetworks[expectedNetwork];
  const containerAddress = containerNetwork?.IPAddress;

  if (
    !id ||
    container.Config?.Labels?.[M23_TEST_LABEL] !== M23_TEST_LABEL_VALUE ||
    network.Name !== expectedNetwork ||
    network.Labels?.[M23_TEST_LABEL] !== M23_TEST_LABEL_VALUE ||
    network.Internal !== true ||
    networkNames.length !== 1 ||
    networkNames[0] !== expectedNetwork ||
    members.length !== 1 ||
    members[0] !== id ||
    !network.Id ||
    containerNetwork?.NetworkID !== network.Id ||
    !networkAddress ||
    !isPrivateIPv4(networkAddress) ||
    !containerAddress ||
    containerAddress !== networkAddress ||
    !pgdataIsWithinTmpfs ||
    !tmpfsTokens.has("rw") ||
    tmpfsTokens.has("ro") ||
    !hasOnlyExpectedTmpfsMounts(container.Mounts) ||
    (container.HostConfig?.Binds?.length ?? 0) !== 0 ||
    (container.HostConfig?.Mounts?.length ?? 0) !== 0 ||
    !hasNoPublishedPorts(container.HostConfig?.PortBindings) ||
    !hasNoPublishedPorts(container.NetworkSettings?.Ports)
  ) {
    throw new Error(
      "Docker isolation preflight failed (expected labeled tmpfs PGDATA on one private internal network, with no persistent mounts or published ports)",
    );
  }

  return networkAddress;
}

/** Exposes a vetted internal-network target only to this host's IPv4 loopback interface. */
export async function startLoopbackTcpRelay(
  upstreamHost: string,
  upstreamPort: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  if (
    !isIPv4(upstreamHost) ||
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  ) {
    throw new Error("The isolated database relay requires a validated IPv4 target and port");
  }

  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    if (client.remoteAddress !== "127.0.0.1" && client.remoteAddress !== "::ffff:127.0.0.1") {
      client.destroy();
      return;
    }
    sockets.add(client);
    const upstream = createConnection({ host: upstreamHost, port: upstreamPort });
    sockets.add(upstream);
    client.once("close", () => sockets.delete(client));
    upstream.once("close", () => sockets.delete(upstream));
    const destroyPair = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", destroyPair);
    upstream.once("error", destroyPair);
    upstream.once("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The isolated database relay did not bind to IPv4 loopback");
  }

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
