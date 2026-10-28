import { describe, expect, it } from "vitest";
import { checkCompose, loadCompose } from "../check-compose-policy";

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
    const doc = { services: { a: { image: `x/y:1@${DIGEST}`, mem_limit: "1g" }, b: { image: `x/y:1@${DIGEST}` } } };
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
    const doc = { services: { api: { image: "${I}", ...bounded }, seed: { extends: { service: "api" } } } };
    expect(checkCompose(doc)).toEqual([]);
  });

  it("passes on the real production compose file", () => {
    expect(checkCompose(loadCompose())).toEqual([]);
  });
});
