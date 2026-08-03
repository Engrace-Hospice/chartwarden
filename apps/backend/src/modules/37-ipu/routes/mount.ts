// apps/backend/src/modules/37-ipu/routes/mount.ts — M37 route mount (§4.1). `mountM37Routes` is the single
// composition-root entry (the mountM35Routes precedent), behind the same authenticate/security/error chain
// as every other module. T11b mounts the core spine (unit list/create, admission list/read/open, bed
// cleaning-status, census read) over the Drizzle route service; the remaining §4.1 routes extend this.
import type { FastifyInstance } from "fastify";
import { type IpuRouteDeps, registerIpuRoutes } from "./ipu.routes";
import type { IpuRouteService } from "./service";

export { registerIpuRoutes, type IpuRouteDeps } from "./ipu.routes";

export interface M37MountDeps {
  readonly service: IpuRouteService;
}

export function mountM37Routes(app: FastifyInstance, deps: M37MountDeps): void {
  const routeDeps: IpuRouteDeps = { service: deps.service };
  registerIpuRoutes(app, routeDeps);
}
