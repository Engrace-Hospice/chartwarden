import { describe, expect, it } from "vitest";
import {
  RESET,
  checkCompose,
  checkRustEnvExample,
  checkRustEnvScope,
  checkRustTopology,
  loadCompose,
} from "../check-compose-policy";

const DIGEST = `sha256:${"a".repeat(64)}`;
const bounded = { mem_limit: "1g", cpus: 1 };

describe("arch:compose-policy", () => {
  it("accepts a pinned, bounded service and an interpolated app image", () => {
    const doc = {
      services: {
        postgres: { image: `pgvector/pgvector:pg18@${DIGEST}`, ...bounded, mem_reservation: "1g" },
        api: { image: "${CHARTWARDEN_IMAGE:?set}", ...bounded },
      },
    };
    expect(checkCompose(doc)).toEqual([]);
  });

  it("rejects a tag-only image, a digest without a tag, and :latest", () => {
    const doc = {
      services: {
        a: { image: "valkey/valkey:8-alpine", ...bounded },
        b: { image: `valkey/valkey@${DIGEST}`, ...bounded },
        c: { image: "minio/minio:latest", ...bounded },
      },
    };
    expect(checkCompose(doc)).toHaveLength(3);
  });

  it("rejects a service without mem_limit or cpus", () => {
    const doc = {
      services: {
        a: { image: `x/y:1@${DIGEST}`, mem_limit: "1g" },
        b: { image: `x/y:1@${DIGEST}` },
      },
    };
    expect(checkCompose(doc)).toEqual([
      "a: missing cpus (#856)",
      "b: missing mem_limit (#856)",
      "b: missing cpus (#856)",
    ]);
  });

  it("requires postgres to reserve memory", () => {
    const doc = { services: { postgres: { image: `x/y:1@${DIGEST}`, ...bounded } } };
    expect(checkCompose(doc)[0]).toContain("postgres: missing mem_reservation");
  });

  it("lets an extending service inherit limits from its base", () => {
    const doc = {
      services: { api: { image: "${I}", ...bounded }, seed: { extends: { service: "api" } } },
    };
    expect(checkCompose(doc)).toEqual([]);
  });

  it("passes on the real production compose file", () => {
    expect(checkCompose(loadCompose())).toEqual([]);
  });
});

describe("arch:compose-policy — CW-RUST-M02 Rust topology", () => {
  const rust = {
    image: `\${CHARTWARDEN_RUST_IMAGE:-ghcr.io/engrace-hospice/chartwarden-rust:unset@sha256:${"0".repeat(64)}}`,
    volumes: ["rust-sock:/run/cw-rust"],
    networks: ["rust-db"],
    ...bounded,
  };
  const networks = { "rust-db": { internal: true } };
  const api = {
    image: "${CHARTWARDEN_IMAGE:?set}",
    volumes: ["rust-sock:/run/cw-rust"],
    ...bounded,
  };

  it("accepts one rust service on the socket shared with api", () => {
    expect(checkRustTopology({ services: { api, rust }, networks })).toEqual([]);
  });

  it.each([
    [
      "published ports",
      { rust: { ...rust, ports: ["127.0.0.1:8080:8080"] } },
      "must not publish ports",
    ],
    ["scale 2", { rust: { ...rust, scale: 2 } }, "scale must be absent or 1"],
    ["deploy.replicas 3", { rust: { ...rust, deploy: { replicas: 3 } } }, "deploy.replicas"],
    [
      "CW_RUST_TCP (map)",
      { rust: { ...rust, environment: { CW_RUST_TCP: "127.0.0.1:9" } } },
      "CW_RUST_TCP",
    ],
    [
      "CW_RUST_TCP (list)",
      { rust: { ...rust, environment: ["CW_RUST_TCP=127.0.0.1:9"] } },
      "CW_RUST_TCP",
    ],
    ["a second rust service", { rust, "rust-2": rust }, "more than one service"],
    ["the wrong service name", { "rust-api": rust }, 'must run as the "rust" service'],
    ["no socket volume", { rust: { ...rust, volumes: [] } }, "must mount"],
    ["another service on the socket", { rust, worker: { ...api } }, "worker: only api and rust"],
    [
      "long-form volume on another service",
      {
        rust,
        web: {
          ...bounded,
          image: "${W}",
          volumes: [{ type: "volume", source: "rust-sock", target: "/x" }],
        },
      },
      "web: only api and rust",
    ],
    [
      "a service extending rust",
      { rust, shadow: { extends: { service: "rust" }, ports: ["9:9"] } },
      "more than one service",
    ],
    [
      "a rust-named service with another image",
      { rust: { ...rust, image: "${OTHER}", ports: ["1:1"] } },
      "must not publish ports",
    ],
    ["env_file on rust", { rust: { ...rust, env_file: [".env.production"] } }, "takes no env_file"],
    [
      "volumes_from api",
      { rust, sidecar: { ...bounded, image: "${S}", volumes_from: ["api"] } },
      "volumes_from api",
    ],
    [
      "volumes_from service:rust:ro",
      { rust, sidecar: { ...bounded, image: "${S}", volumes_from: ["service:rust:ro"] } },
      "volumes_from rust",
    ],
    [
      "a service inheriting api's socket mount",
      { rust, "seed-api": { extends: { service: "api" } } },
      "seed-api: only api and rust",
    ],
  ])("rejects %s", (_label, services, message) => {
    const failures = checkRustTopology({ services: { api, ...services } as never, networks });
    expect(failures.join("\n")).toContain(message);
  });

  it.each([
    [
      "rust on the default network",
      { rust: { ...rust, networks: ["default", "rust-db"] } },
      networks,
      'exactly the "rust-db" network',
    ],
    [
      "rust with no networks key",
      { rust: { ...rust, networks: undefined } },
      networks,
      'exactly the "rust-db" network',
    ],
    [
      "a mutable rust image tag",
      { rust: { ...rust, image: "${CHARTWARDEN_RUST_IMAGE:-ghcr.io/x/chartwarden-rust:latest}" } },
      networks,
      "digest-pinned",
    ],
    ["rust-db not internal", { rust }, { "rust-db": {} }, "internal: true"],
    [
      "another service on rust-db",
      { rust, worker: { image: "${W}", ...bounded, networks: ["default", "rust-db"] } },
      networks,
      "worker: only postgres and rust",
    ],
  ])("rejects %s", (_label, services, nets, message) => {
    const failures = checkRustTopology({
      services: { api, ...services } as never,
      networks: nets as never,
    });
    expect(failures.join("\n")).toContain(message);
  });

  it("honours !reset when a service extends api", () => {
    const failures = checkRustTopology({
      services: { api, rust, "seed-api": { extends: { service: "api" }, volumes: RESET } } as never,
      networks,
    });
    expect(failures).toEqual([]);
  });

  it("the real production compose file holds the topology", () => {
    expect(checkRustTopology(loadCompose())).toEqual([]);
  });
});

describe("arch:compose-policy — RUST_* settings reach api only (P2 prerequisite 3)", () => {
  const api = {
    image: "${CHARTWARDEN_IMAGE:?set}",
    ...bounded,
    environment: { RUST_ROUTES: "", RUST_ROUTE_MODE: "shadow", RUST_PARITY_SWEEP: "off" },
  };
  const worker = { image: "${CHARTWARDEN_IMAGE:?set}", ...bounded };

  it("accepts RUST_* literals on api and RUST_LOG on rust", () => {
    const services = { api, worker, rust: { ...worker, environment: { RUST_LOG: "info" } } };
    expect(checkRustEnvScope({ services } as never)).toEqual([]);
  });

  it.each([
    ["map", { environment: { RUST_ROUTES: "/api/v1/me/permissions" } }],
    ["list", { environment: ["RUST_ROUTES=/api/v1/me/permissions"] }],
    ["list, no value", { environment: ["RUST_PARITY_SWEEP"] }],
  ])("rejects RUST_* on worker (%s)", (_label, extra) => {
    const failures = checkRustEnvScope({
      services: { api, worker: { ...worker, ...extra } },
    } as never);
    expect(failures.join("\n")).toContain("worker: RUST_");
  });

  it("rejects RUST_LOG anywhere but rust", () => {
    const failures = checkRustEnvScope({
      services: { api, worker: { ...worker, environment: { RUST_LOG: "debug" } } },
    } as never);
    expect(failures.join("\n")).toContain("worker: RUST_LOG");
  });

  it("rejects a service that inherits api's RUST_* through extends", () => {
    const failures = checkRustEnvScope({
      services: { api, "seed-api": { extends: { service: "api" }, environment: { X: "1" } } },
    } as never);
    expect(failures.join("\n")).toContain("seed-api: RUST_ROUTES");
  });

  it("accepts an extending service that resets the inherited RUST_* keys", () => {
    const reset = { RUST_ROUTES: RESET, RUST_ROUTE_MODE: RESET, RUST_PARITY_SWEEP: RESET };
    const failures = checkRustEnvScope({
      services: { api, "seed-api": { extends: { service: "api" }, environment: reset } },
    } as never);
    expect(failures).toEqual([]);
  });

  it("rejects an interpolated RUST_* value on api (compose would read .env.production)", () => {
    const failures = checkRustEnvScope({
      services: { api: { ...api, environment: { RUST_ROUTES: "${RUST_ROUTES:-}" } } },
    } as never);
    expect(failures.join("\n")).toContain("api: RUST_ROUTES");
    expect(failures.join("\n")).toContain("literal");
  });

  it("the real production compose file keeps RUST_* on api, switched off", () => {
    const doc = loadCompose();
    expect(checkRustEnvScope(doc)).toEqual([]);
    const env = (doc.services?.api?.environment ?? {}) as Record<string, string>;
    expect(env).toMatchObject({
      RUST_ROUTES: "",
      RUST_ROUTE_MODE: "shadow",
      RUST_SOCKET: "/run/cw-rust/cw-rust.sock",
      RUST_TIMEOUT_MS: "300",
      RUST_PARITY_SWEEP: "off",
    });
  });

  it("flags an active RUST_* assignment in the env file example, not a comment", () => {
    expect(checkRustEnvExample("A=1\n# RUST_ROUTES=/x is set in compose.yml\n")).toEqual([]);
    expect(checkRustEnvExample("A=1\nRUST_ROUTES=/x\n").join("\n")).toContain("RUST_ROUTES");
  });
});
