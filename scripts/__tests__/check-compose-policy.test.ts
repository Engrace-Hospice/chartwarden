import { describe, expect, it } from "vitest";
import { checkCompose, checkRustTopology, loadCompose } from "../check-compose-policy";

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
    image: "${CHARTWARDEN_RUST_IMAGE:-ghcr.io/engrace-hospice/chartwarden-rust:unset}",
    volumes: ["rust-sock:/run/cw-rust"],
    ...bounded,
  };
  const api = {
    image: "${CHARTWARDEN_IMAGE:?set}",
    volumes: ["rust-sock:/run/cw-rust"],
    ...bounded,
  };

  it("accepts one rust service on the socket shared with api", () => {
    expect(checkRustTopology({ services: { api, rust } })).toEqual([]);
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
  ])("rejects %s", (_label, services, message) => {
    const failures = checkRustTopology({ services: { api, ...services } as never });
    expect(failures.join("\n")).toContain(message);
  });

  it("the real production compose file holds the topology", () => {
    expect(checkRustTopology(loadCompose())).toEqual([]);
  });
});
