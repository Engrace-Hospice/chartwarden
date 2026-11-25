import { spawnSync } from "node:child_process";

export function assertLocalDockerEndpoint(endpoint: string): void {
  let local = endpoint.startsWith("unix://") || endpoint.startsWith("npipe://");
  if (endpoint.startsWith("tcp://")) {
    try {
      const url = new URL(endpoint.replace(/^tcp:/, "http:"));
      local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    } catch {
      local = false;
    }
  }
  if (!local)
    throw new Error("refusing to run destructive intake cleanup on a non-local Docker daemon");
}

/** Resolve the effective context as well as DOCKER_HOST before any container, image, or volume write. */
export function verifyLocalDockerDaemon(env: NodeJS.ProcessEnv): void {
  if (env.DOCKER_HOST) assertLocalDockerEndpoint(env.DOCKER_HOST);
  const result = spawnSync("docker", ["context", "inspect"], {
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("could not inspect the effective Docker context");
  const contexts = JSON.parse(result.stdout) as {
    Endpoints?: { docker?: { Host?: unknown } };
  }[];
  const endpoint = contexts[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== "string")
    throw new Error("Docker context did not expose its daemon endpoint");
  assertLocalDockerEndpoint(endpoint);
}
