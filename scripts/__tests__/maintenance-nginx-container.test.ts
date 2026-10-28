import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #865 — the maintenance snippet against a REAL nginx (nginx:stable in Docker), not just its text. Skipped when Docker
// or the image is unavailable (a fresh `docker pull` is attempted once). The container is always removed afterwards.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NGINX_DIR = join(ROOT, "deploy/production/nginx");
const IMAGE = "nginx:stable";
const NAME = `cw-maint-test-${process.pid}`;
const FLAG = "/etc/nginx/chartwarden-maintenance.on";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const dockerReady = (): boolean =>
  docker("info").status === 0 && (docker("image", "inspect", IMAGE).status === 0 || docker("pull", "-q", IMAGE).status === 0);

const HAVE_DOCKER = dockerReady();
let base = "";

async function status(path: string, method = "GET"): Promise<{ code: number; retryAfter: string | null; body: string }> {
  const res = await fetch(`${base}${path}`, { method, redirect: "manual" });
  return { code: res.status, retryAfter: res.headers.get("retry-after"), body: await res.text() };
}

describe.skipIf(!HAVE_DOCKER)("maintenance snippet on a real nginx", () => {
  beforeAll(async () => {
    const run = docker(
      "run", "-d", "--name", NAME, "-p", "127.0.0.1::80",
      "-v", `${NGINX_DIR}/chartwarden-maintenance.conf:/etc/nginx/snippets/chartwarden-maintenance.conf:ro`,
      "-v", `${NGINX_DIR}/chartwarden-log-format.conf:/etc/nginx/conf.d/00-log-format.conf:ro`,
      "-v", `${NGINX_DIR}/chartwarden-frontend.conf:/etc/nginx/conf.d/default.conf:ro`,
      IMAGE,
    );
    expect(run.status, run.stderr).toBe(0);
    const port = docker("port", NAME, "80/tcp").stdout.trim().split(":").pop();
    base = `http://127.0.0.1:${port}`;
    // nginx is up once any request is answered (502: the vhost's upstreams do not exist in this container).
    for (let i = 0; i < 50; i += 1) {
      try {
        await status("/");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("nginx did not start");
  }, 180_000);

  afterAll(() => {
    docker("rm", "-f", NAME);
  });

  const setFlag = (on: boolean) => {
    const r = docker("exec", NAME, "sh", "-c", on ? `touch ${FLAG}` : `rm -f ${FLAG}`);
    expect(r.status, r.stderr).toBe(0);
  };

  it("the config is valid", () => {
    expect(docker("exec", NAME, "nginx", "-t").status).toBe(0);
  });

  it("flag off: nothing is answered by the maintenance page", async () => {
    setFlag(false);
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "POST"]) {
      expect((await status("/", method)).code, method).not.toBe(503);
    }
  });

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "flag on: %s gets 503 with Retry-After",
    async (method) => {
      setFlag(true);
      const r = await status("/some/page", method);
      expect(r.code).toBe(503);
      expect(r.retryAfter).toBe("600");
      if (method !== "HEAD") expect(r.body).toContain("briefly unavailable");
    },
  );

  it("flag on: api paths are gated too", async () => {
    setFlag(true);
    expect((await status("/api/v1/patients", "POST")).code).toBe(503);
  });

  it("flag on: /ready and /health are exempt, but not look-alikes (/ready%0a, /ready/, /readyx)", async () => {
    setFlag(true);
    expect((await status("/ready")).code).not.toBe(503);
    expect((await status("/health")).code).not.toBe(503);
    for (const path of ["/ready%0a", "/health%0a", "/ready/", "/readyx"]) {
      expect((await status(path)).code, path).toBe(503);
    }
  });

  it("flag removed: service resumes on the next request without a reload", async () => {
    setFlag(true);
    expect((await status("/")).code).toBe(503);
    setFlag(false);
    expect((await status("/")).code).not.toBe(503);
  });
});
