import { type Server, createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type M23ContainerInspection,
  type M23NetworkInspection,
  assertFreshM23DatabaseInventory,
  buildM23VitestEnvironment,
  isCompleteM23Qualification,
  isM23SuiteEntirelySkipped,
  runM23Child,
  startLoopbackTcpRelay,
  summarizeVitestFailureMessage,
  validateM23DockerIsolation,
} from "../m23-rls-isolation";
import {
  M23_TARGET_DIAGNOSTIC_PREFIX,
  inspectM23TargetModuleEnvironment,
  isM23TargetModuleEnvironmentSafe,
  parseM23TargetModuleDiagnostic,
  parseM23TargetModuleDiagnosticJson,
  validateM23DynamicCollection,
} from "../m23-rls-target-diagnostic";

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

  it("classifies setup-hook failures without exposing their raw messages", () => {
    const summary = summarizeVitestFailureMessage(
      "Error in beforeAll hook: password authentication failed for user postgres; m23-rls-isolation.live.test.ts:544:9",
    );
    expect(summary).toContain("Vitest beforeAll setup hook failed");
    expect(summary).toContain("M23 suite source line: 544");
    expect(summary.join(" ")).not.toContain("password");
    expect(summary.join(" ")).not.toContain("postgres");
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

  it("detects a suite skipped before any live assertion runs", () => {
    expect(
      isM23SuiteEntirelySkipped({ total: 19, passed: 0, failed: 0, pending: 19, todo: 0 }),
    ).toBe(true);
    expect(
      isM23SuiteEntirelySkipped({ total: 19, passed: 0, failed: 0, pending: 18, todo: 1 }),
    ).toBe(false);
    expect(isM23SuiteEntirelySkipped({ total: 0, passed: 0, failed: 0, pending: 0, todo: 0 })).toBe(
      false,
    );
  });
});

describe("M23 isolated Vitest environment", () => {
  it("forwards only runtime essentials and the verified private-cluster identity", () => {
    const env = buildM23VitestEnvironment(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/home/tester",
        TMPDIR: "/host/tmp",
        NODE_OPTIONS: "--require hostile-preload",
        BUN_OPTIONS: "--env-file=.env",
        CHARTWARDEN_TEST_DATABASE_URL: "postgresql://shared-db.invalid/shared",
        CHARTWARDEN_M23_RLS_ISOLATED_RUN: "false",
      },
      {
        databaseUrl: "postgresql://127.0.0.1:39443/m23_test",
        clusterName: "chartwarden-m23-0123456789abcdef0123456789abcdef",
        systemIdentifier: "7710508504555474985",
        privateWorkDir: "/private/m23-run",
      },
    );

    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/private/m23-run",
      TMPDIR: "/private/m23-run",
      NODE_ENV: "test",
      CHARTWARDEN_TEST_DATABASE_URL: "postgresql://127.0.0.1:39443/m23_test",
      CHARTWARDEN_M23_RLS_ISOLATED_RUN: "true",
      CHARTWARDEN_TEST_CLUSTER_ID: "chartwarden-m23-0123456789abcdef0123456789abcdef",
      CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER: "7710508504555474985",
    });
  });
});

describe("M23 target-module diagnostic", () => {
  const completeEnvironment = {
    CHARTWARDEN_M23_RLS_ISOLATED_RUN: "true",
    CHARTWARDEN_TEST_DATABASE_URL:
      "postgresql://synthetic:synthetic@127.0.0.1:9/m23_0123456789abcdef0123456789abcdef",
    CHARTWARDEN_TEST_CLUSTER_ID: "chartwarden-m23-0123456789abcdef0123456789abcdef",
    CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER: "7710508504555474985",
  };

  it.each([
    ["missing", undefined, "guard_skips_suite"],
    ["false", "false", "guard_skips_suite"],
    ["malformed", "TRUE", "guard_skips_suite"],
  ] as const)("reports a %s isolation marker as skipped", (_label, marker, decision) => {
    const diagnostic = inspectM23TargetModuleEnvironment({
      ...completeEnvironment,
      CHARTWARDEN_M23_RLS_ISOLATED_RUN: marker,
    });
    expect(diagnostic.isolatedMarkerState).toBe(_label);
    expect(diagnostic.moduleGuardDecision).toBe(decision);
    expect(diagnostic.privateDatabaseUrlPresent).toBe(true);
  });

  it("reports a true marker without a database URL as a module refusal", () => {
    const diagnostic = inspectM23TargetModuleEnvironment({
      ...completeEnvironment,
      CHARTWARDEN_TEST_DATABASE_URL: undefined,
    });
    expect(diagnostic.isolatedMarkerEqualsTrue).toBe(true);
    expect(diagnostic.privateDatabaseUrlPresent).toBe(false);
    expect(diagnostic.moduleGuardDecision).toBe("refuses_missing_database_url");
  });

  it("reports that the module guard permits registration without claiming Vitest execution mode", () => {
    const diagnostic = inspectM23TargetModuleEnvironment(completeEnvironment);
    expect(diagnostic).toEqual({
      targetModuleEvaluated: true,
      isolatedMarkerState: "true",
      isolatedMarkerPresent: true,
      isolatedMarkerEqualsTrue: true,
      privateDatabaseUrlPresent: true,
      clusterIdentityMarkersPresent: true,
      clusterIdentityMarkersWellFormed: true,
      moduleGuardDecision: "guard_allows_suite_registration",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic");
    expect(JSON.stringify(diagnostic)).not.toContain("7710508504555474985");
    expect(isM23TargetModuleEnvironmentSafe(diagnostic)).toBe(true);
  });

  it("rejects malformed or missing cluster identity markers", () => {
    const diagnostic = inspectM23TargetModuleEnvironment({
      ...completeEnvironment,
      CHARTWARDEN_TEST_CLUSTER_ID: "unexpected-cluster",
      CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER: "not-a-number",
    });
    expect(diagnostic.clusterIdentityMarkersPresent).toBe(true);
    expect(diagnostic.clusterIdentityMarkersWellFormed).toBe(false);
    expect(isM23TargetModuleEnvironmentSafe(diagnostic)).toBe(false);
    expect(
      inspectM23TargetModuleEnvironment({
        ...completeEnvironment,
        CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER: undefined,
      }).clusterIdentityMarkersPresent,
    ).toBe(false);
  });

  it("parses one safe module diagnostic and rejects missing or ambiguous diagnostics", () => {
    const diagnostic = inspectM23TargetModuleEnvironment(completeEnvironment);
    const line = `${M23_TARGET_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`;
    expect(parseM23TargetModuleDiagnostic(`Vitest output\n${line}\n`)).toEqual(diagnostic);
    expect(
      parseM23TargetModuleDiagnosticJson(
        JSON.stringify({ ...diagnostic, databaseUrl: "postgresql://private:secret" }),
      ),
    ).toEqual(diagnostic);
    expect(() => parseM23TargetModuleDiagnostic("no target-module record")).toThrow(
      /missing or ambiguous/,
    );
    expect(() => parseM23TargetModuleDiagnostic(`${line}\n${line}`)).toThrow(
      /missing or ambiguous/,
    );
    expect(() =>
      parseM23TargetModuleDiagnostic(
        `${M23_TARGET_DIAGNOSTIC_PREFIX}{"databaseUrl":"postgresql://secret"}`,
      ),
    ).toThrow(/invalid shape/);
  });
});

describe("M23 dynamic Vitest collection", () => {
  const expectedFile = "/repo/packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts";
  const expectedNames = Array.from({ length: 19 }, (_, index) => `M23 assertion ${index + 1}`);
  const tests = expectedNames.map((name) => ({
    name,
    file: expectedFile,
    projectName: "node",
  }));

  it("accepts the expected dynamically collected test file and project", () => {
    expect(() =>
      validateM23DynamicCollection({
        tests,
        expectedFile,
        expectedProject: "node",
        expectedNames,
      }),
    ).not.toThrow();
  });

  it("rejects a wrong target file", () => {
    const altered = tests.map((test) => ({ ...test }));
    altered[0]!.file = "/repo/packages/other.test.ts";
    expect(() =>
      validateM23DynamicCollection({
        tests: altered,
        expectedFile,
        expectedProject: "node",
        expectedNames,
      }),
    ).toThrow(/M23 dynamic collection/);
  });

  it("rejects a wrong Vitest project", () => {
    const altered = tests.map((test) => ({ ...test }));
    altered[0]!.projectName = "dom";
    expect(() =>
      validateM23DynamicCollection({
        tests: altered,
        expectedFile,
        expectedProject: "node",
        expectedNames,
      }),
    ).toThrow(/M23 dynamic collection/);
  });

  it("rejects a changed assertion set even when its count is unchanged", () => {
    const altered = [...expectedNames.slice(0, -1), "different assertion"];
    expect(() =>
      validateM23DynamicCollection({
        tests,
        expectedFile,
        expectedProject: "node",
        expectedNames: altered,
      }),
    ).toThrow(/expected registered assertions/);
  });

  it("rejects an unexpected assertion count", () => {
    expect(() =>
      validateM23DynamicCollection({
        tests,
        expectedFile,
        expectedProject: "node",
        expectedNames: [...expectedNames, "unexpected assertion"],
      }),
    ).toThrow(/expected registered assertion count/);
  });
});

if (process.env.CHARTWARDEN_M23_RLS_ENV_PROBE === "true") {
  describe("M23 Vitest worker environment probe", () => {
    it("receives the isolated runner values before the database suite starts", () => {
      let privateDatabaseUrl: URL | undefined;
      try {
        privateDatabaseUrl = new URL(process.env.CHARTWARDEN_TEST_DATABASE_URL ?? "");
      } catch {
        privateDatabaseUrl = undefined;
      }
      const clusterId = (process.env.CHARTWARDEN_TEST_CLUSTER_ID ?? "").replace(
        /^chartwarden-m23-/,
        "",
      );
      expect(process.env.CHARTWARDEN_M23_RLS_ISOLATED_RUN === "true").toBe(true);
      expect(
        privateDatabaseUrl?.protocol === "postgresql:" &&
          privateDatabaseUrl.hostname === "127.0.0.1" &&
          /^\d+$/.test(privateDatabaseUrl.port) &&
          privateDatabaseUrl.pathname === `/m23_${clusterId}`,
      ).toBe(true);
      expect(
        /^chartwarden-m23-[a-f0-9]{32}$/.test(process.env.CHARTWARDEN_TEST_CLUSTER_ID ?? ""),
      ).toBe(true);
      expect(/^\d+$/.test(process.env.CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER ?? "")).toBe(true);
    });
  });
}

describe("loopback-only M23 database relay", () => {
  it("bounds a timed-out process tree even when a descendant inherits its pipes", async () => {
    const started = Date.now();
    await expect(
      runM23Child(
        process.execPath,
        [
          "-e",
          'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000);',
        ],
        { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 250 },
      ),
    ).rejects.toThrow("M23 child process timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("serves a child process while it waits on the relay", async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    openServers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fake listener did not bind");

    const relay = await startLoopbackTcpRelay("127.0.0.1", address.port);
    try {
      const child = await runM23Child(
        process.execPath,
        [
          "-e",
          'const net = require("node:net"); const socket = net.connect(Number(process.argv[1]), "127.0.0.1"); socket.on("connect", () => socket.write("synthetic-child-ping")); socket.on("data", (data) => { process.stdout.write(data); socket.end(); });',
          String(relay.port),
        ],
        { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 2_000 },
      );
      expect(child).toMatchObject({ status: 0, stdout: "synthetic-child-ping", stderr: "" });
    } finally {
      await relay.close();
    }
  });

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
