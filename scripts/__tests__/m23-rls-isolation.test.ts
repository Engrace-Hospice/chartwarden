import { type Server, createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type M23ContainerInspection,
  type M23NetworkInspection,
  assertFreshM23DatabaseInventory,
  isCompleteM23Qualification,
  startLoopbackTcpRelay,
  summarizeVitestFailureMessage,
  validateM23DockerIsolation,
} from "../m23-rls-isolation";

const networkName = "chartwarden-m23-net-test";
const baseContainer: M23ContainerInspection = {
  Id: "container-test-id",
  Config: {
    Labels: { "com.chartwarden.test-suite": "m23-rls-live" },
    Env: ["PGDATA=/var/lib/postgresql/18/docker"],
  },
  HostConfig: {
    Binds: null,
    Mounts: null,
    Tmpfs: { "/var/lib/postgresql": "rw,nosuid,size=2g,uid=999,gid=999" },
    PortBindings: null,
  },
  Mounts: [],
  NetworkSettings: {
    Networks: {
      [networkName]: { NetworkID: "network-test-id", IPAddress: "172.30.0.2" },
    },
    Ports: { "5432/tcp": null },
  },
};
const baseNetwork: M23NetworkInspection = {
  Id: "network-test-id",
  Name: networkName,
  Internal: true,
  Labels: { "com.chartwarden.test-suite": "m23-rls-live" },
  Containers: { "container-test-id": { IPv4Address: "172.30.0.2/16" } },
};

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function validate(
  container: M23ContainerInspection = structuredClone(baseContainer),
  network: M23NetworkInspection = structuredClone(baseNetwork),
) {
  return validateM23DockerIsolation({ container, network, expectedNetwork: networkName });
}

describe("M23 isolated RLS Docker preflight", () => {
  it("accepts Docker's HostConfig.Tmpfs representation when Mounts is empty", () => {
    expect(validate()).toBe("172.30.0.2");
  });

  it("accepts an explicit matching tmpfs mount representation", () => {
    const container = structuredClone(baseContainer);
    container.Mounts = [{ Type: "tmpfs", Destination: "/var/lib/postgresql" }];
    expect(validate(container)).toBe("172.30.0.2");
  });

  const unsafeConfigurations: {
    name: string;
    mutate: (container: M23ContainerInspection) => void;
  }[] = [
    {
      name: "missing tmpfs configuration",
      mutate(container) {
        container.HostConfig!.Tmpfs = {};
      },
    },
    {
      name: "read-only tmpfs configuration",
      mutate(container) {
        container.HostConfig!.Tmpfs!["/var/lib/postgresql"] = "ro,nosuid";
      },
    },
    {
      name: "PGDATA outside tmpfs",
      mutate(container) {
        container.Config!.Env = ["PGDATA=/var/lib/postgresql-data/cluster"];
      },
    },
    {
      name: "PGDATA path traversal",
      mutate(container) {
        container.Config!.Env = ["PGDATA=/var/lib/postgresql/../../tmp/cluster"];
      },
    },
    {
      name: "duplicate PGDATA configuration",
      mutate(container) {
        container.Config!.Env!.push("PGDATA=/other/cluster");
      },
    },
    {
      name: "a bind mount",
      mutate(container) {
        container.HostConfig!.Binds = ["/host:/var/lib/postgresql"];
      },
    },
    {
      name: "a configured volume",
      mutate(container) {
        container.HostConfig!.Mounts = [{}];
      },
    },
    {
      name: "a persistent Docker mount",
      mutate(container) {
        container.Mounts = [{ Type: "volume", Destination: "/var/lib/postgresql" }];
      },
    },
    {
      name: "a published port",
      mutate(container) {
        container.HostConfig!.PortBindings = {
          "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }],
        };
      },
    },
    {
      name: "a published port reported in network settings",
      mutate(container) {
        container.NetworkSettings!.Ports = {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        };
      },
    },
  ];

  it.each(unsafeConfigurations)("rejects $name", ({ mutate }) => {
    const container = structuredClone(baseContainer);
    mutate(container);
    expect(() => validate(container)).toThrow(/Docker isolation preflight failed/);
  });

  it("rejects a non-internal or shared network", () => {
    const network = structuredClone(baseNetwork);
    network.Internal = false;
    expect(() => validate(undefined, network)).toThrow(/Docker isolation preflight failed/);

    const sharedNetwork = structuredClone(baseNetwork);
    sharedNetwork.Containers!["another-container"] = { IPv4Address: "172.30.0.3/16" };
    expect(() => validate(undefined, sharedNetwork)).toThrow(/Docker isolation preflight failed/);
  });

  it("rejects additional container network attachments", () => {
    const container = structuredClone(baseContainer);
    container.NetworkSettings!.Networks!.other = {
      NetworkID: "other-id",
      IPAddress: "172.31.0.2",
    };
    expect(() => validate(container)).toThrow(/Docker isolation preflight failed/);
  });

  it("rejects a container address outside private IPv4 ranges", () => {
    const container = structuredClone(baseContainer);
    const network = structuredClone(baseNetwork);
    container.NetworkSettings!.Networks![networkName]!.IPAddress = "203.0.113.7";
    network.Containers!["container-test-id"]!.IPv4Address = "203.0.113.7/24";
    expect(() => validate(container, network)).toThrow(/Docker isolation preflight failed/);
  });
});

describe("M23 disposable database inventory", () => {
  it("accepts only the default database and the expected test database", () => {
    expect(() =>
      assertFreshM23DatabaseInventory(["chartwarden_test", "postgres"], "chartwarden_test"),
    ).not.toThrow();
  });

  it("rejects unexpected databases and reports their names", () => {
    expect(() =>
      assertFreshM23DatabaseInventory(
        ["chartwarden_test", "postgres", "unexpected_db"],
        "chartwarden_test",
      ),
    ).toThrow(/unexpected_db/);
  });

  it("rejects an inventory missing either required database", () => {
    expect(() => assertFreshM23DatabaseInventory(["chartwarden_test"], "chartwarden_test")).toThrow(
      /not fresh/,
    );
    expect(() =>
      assertFreshM23DatabaseInventory(["postgres", "other_test"], "chartwarden_test"),
    ).toThrow(/not fresh/);
  });
});

describe("M23 Vitest failure diagnostics", () => {
  it("emits only allowlisted facts from arbitrary failure text", () => {
    const summary = summarizeVitestFailureMessage(
      "Error: Hook timed out in 120000ms\ncode: '28031'\nat packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts:547:5\nJane Testpatient, 900-12-3456, 1EG4TE5MK73, postgresql://postgres:private@127.0.0.1/db",
    );
    const diagnostic = summary.join("\n");

    expect(summary).toContain("Hook timeout: 120000ms");
    expect(diagnostic).not.toContain("28031");
    expect(summary).toContain("Failure class: Error");
    expect(summary).toContain("M23 suite source line: 547");
    expect(diagnostic).not.toContain("Jane Testpatient");
    expect(diagnostic).not.toContain("900-12-3456");
    expect(diagnostic).not.toContain("1EG4TE5MK73");
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain("postgresql://");
  });

  it("reports only that raw failure details were withheld when no safe fact is found", () => {
    expect(summarizeVitestFailureMessage("sensitive free-form message")).toEqual([
      "No allowlisted failure detail; raw diagnostic withheld.",
    ]);
    expect(summarizeVitestFailureMessage("code: '1EG4T'")).toEqual([
      "No allowlisted failure detail; raw diagnostic withheld.",
    ]);
  });

  it("identifies the fixed isolated-runner database URL guard", () => {
    expect(
      summarizeVitestFailureMessage(
        "Error: M23 isolated runner did not provide CHARTWARDEN_TEST_DATABASE_URL",
      ),
    ).toEqual([
      "Isolated runner database URL missing from Vitest environment",
      "Failure class: Error",
    ]);
  });
});

describe("M23 qualification completeness", () => {
  const complete = {
    exitStatus: 0,
    total: 19,
    passed: 19,
    failed: 0,
    pending: 0,
    todo: 0,
  };

  it("accepts only a complete passing run", () => {
    expect(isCompleteM23Qualification(complete)).toBe(true);
  });

  it.each([
    { exitStatus: 1 },
    { total: 0 },
    { failed: 1 },
    { pending: 1 },
    { todo: 1 },
    { passed: 18 },
  ])("rejects incomplete or unsuccessful result %#", (override) => {
    expect(isCompleteM23Qualification({ ...complete, ...override })).toBe(false);
  });
});

describe("loopback-only M23 database relay", () => {
  it("forwards a local synthetic stream through an IPv4 loopback listener", async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    openServers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fake listener did not bind");

    const relay = await startLoopbackTcpRelay("127.0.0.1", address.port);
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: relay.port });
        socket.setTimeout(2_000);
        socket.once("error", reject);
        socket.once("timeout", () => reject(new Error("local relay timed out")));
        socket.once("data", (chunk) => {
          resolve(chunk.toString("utf8"));
          socket.destroy();
        });
        socket.once("connect", () => socket.write("synthetic-m23-ping"));
      });
      expect(echoed).toBe("synthetic-m23-ping");
    } finally {
      await relay.close();
    }
  });
});
