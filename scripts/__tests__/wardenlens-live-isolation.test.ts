import { describe, expect, it } from "vitest";
import {
  type WardenLensContainerInspection,
  assertLocalDockerEndpoint,
  assertFreshWardenLensDatabase,
  assertWardenLensDatabaseIdentity,
  buildWardenLensSuiteEnvironment,
  isCompleteWardenLensSuite,
  validateWardenLensContainerIsolation,
} from "../wardenlens-live-isolation";

const LABEL = "com.chartwarden.test-suite";

function isolatedContainer(): WardenLensContainerInspection {
  return {
    Id: "container-id",
    Config: {
      Image: "chartwarden-postgres:wardenlens-test-abc",
      Labels: { [LABEL]: "wardenlens-live" },
      Env: ["PGDATA=/var/lib/postgresql/data"],
    },
    HostConfig: {
      Binds: null,
      Mounts: null,
      Tmpfs: { "/var/lib/postgresql": "rw,noexec,nosuid,size=2g" },
      PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    },
    Mounts: [],
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    },
  };
}

describe("WardenLens isolated live-suite runner", () => {
  it("accepts local Docker sockets and rejects remote daemon endpoints", () => {
    expect(() => assertLocalDockerEndpoint("unix:///var/run/docker.sock")).not.toThrow();
    expect(() => assertLocalDockerEndpoint("npipe:////./pipe/docker_engine")).not.toThrow();
    expect(() => assertLocalDockerEndpoint("tcp://docker.example:2376")).toThrow(/local Docker/);
    expect(() => assertLocalDockerEndpoint("ssh://operator@host")).toThrow(/local Docker/);
  });

  it("accepts only a labeled tmpfs container with one random loopback PostgreSQL port", () => {
    expect(
      validateWardenLensContainerIsolation(isolatedContainer(), {
        expectedImage: "chartwarden-postgres:wardenlens-test-abc",
        expectedLabel: "wardenlens-live",
      }),
    ).toEqual({ host: "127.0.0.1", port: 49152, pgdata: "/var/lib/postgresql/data" });
  });

  it("accepts Docker's empty requested port when runtime records the assigned loopback port", () => {
    const inspection = isolatedContainer();
    inspection.HostConfig!.PortBindings!["5432/tcp"]![0]!.HostPort = "";
    expect(
      validateWardenLensContainerIsolation(inspection, {
        expectedImage: "chartwarden-postgres:wardenlens-test-abc",
        expectedLabel: "wardenlens-live",
      }),
    ).toEqual({ host: "127.0.0.1", port: 49152, pgdata: "/var/lib/postgresql/data" });
  });

  it.each([
    [
      "persistent bind",
      (x: ReturnType<typeof isolatedContainer>) => {
        x.HostConfig!.Binds = ["/tmp:/var/lib/postgresql"];
      },
    ],
    [
      "non-loopback port",
      (x: ReturnType<typeof isolatedContainer>) => {
        x.NetworkSettings!.Ports!["5432/tcp"]![0]!.HostIp = "0.0.0.0";
      },
    ],
    [
      "wrong image",
      (x: ReturnType<typeof isolatedContainer>) => {
        x.Config!.Image = "postgres:latest";
      },
    ],
    ["missing label", (x: ReturnType<typeof isolatedContainer>) => delete x.Config!.Labels![LABEL]],
    [
      "non-tmpfs PGDATA",
      (x: ReturnType<typeof isolatedContainer>) => {
        x.Config!.Env = ["PGDATA=/data"];
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const inspection = isolatedContainer();
    mutate(inspection);
    expect(() =>
      validateWardenLensContainerIsolation(inspection, {
        expectedImage: "chartwarden-postgres:wardenlens-test-abc",
        expectedLabel: "wardenlens-live",
      }),
    ).toThrow(/isolation preflight failed/);
  });

  it("requires a fresh cluster containing only postgres and the expected test database", () => {
    expect(() =>
      assertFreshWardenLensDatabase(["postgres", "wardenlens_f236_abc"], "wardenlens_f236_abc"),
    ).not.toThrow();
    expect(() =>
      assertFreshWardenLensDatabase(
        ["chartwarden", "postgres", "wardenlens_f236_abc"],
        "wardenlens_f236_abc",
      ),
    ).toThrow(/not fresh/);
  });

  it("requires the exact database, cluster, PostgreSQL 18 superuser and lock setting", () => {
    expect(() =>
      assertWardenLensDatabaseIdentity(
        {
          databaseName: "wardenlens_f236_abc",
          clusterName: "wardenlens-f236-abc",
          serverVersionNum: 180006,
          isSuperuser: true,
          maxLocksPerTransaction: 1024,
          systemIdentifier: "7543210987654321000",
        },
        { databaseName: "wardenlens_f236_abc", clusterName: "wardenlens-f236-abc" },
      ),
    ).not.toThrow();
    expect(() =>
      assertWardenLensDatabaseIdentity(
        {
          databaseName: "chartwarden",
          clusterName: "wardenlens-f236-abc",
          serverVersionNum: 180006,
          isSuperuser: true,
          maxLocksPerTransaction: 1024,
          systemIdentifier: "7543210987654321000",
        },
        { databaseName: "wardenlens_f236_abc", clusterName: "wardenlens-f236-abc" },
      ),
    ).toThrow(/identity preflight failed/);
  });

  it("passes only the minimum environment to Vitest", () => {
    const result = buildWardenLensSuiteEnvironment(
      { PATH: "/bin", HOME: "/real-home", DATABASE_URL: "shared", ANTHROPIC_API_KEY: "secret" },
      { databaseUrl: "postgres://private", privateWorkDir: "/tmp/private" },
    );
    expect(result).toEqual({
      PATH: "/bin",
      HOME: "/tmp/private",
      TMPDIR: "/tmp/private",
      NODE_ENV: "test",
      CI: "true",
      CHARTWARDEN_TEST_DATABASE_URL: "postgres://private",
      CHARTWARDEN_WARDENLENS_ISOLATED_RUN: "true",
    });
  });

  it("does not count skipped or empty suites as passing", () => {
    expect(
      isCompleteWardenLensSuite({
        total: 6,
        passed: 6,
        failed: 0,
        pending: 0,
        todo: 0,
        exitStatus: 0,
      }),
    ).toBe(true);
    expect(
      isCompleteWardenLensSuite({
        total: 6,
        passed: 0,
        failed: 0,
        pending: 6,
        todo: 0,
        exitStatus: 0,
      }),
    ).toBe(false);
    expect(
      isCompleteWardenLensSuite({
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        todo: 0,
        exitStatus: 0,
      }),
    ).toBe(false);
  });
});
