// apps/backend/src/modules/41-billing-commercial/routes/mount.ts - the M41 route mount (the single composition-root entry).
import type { FastifyInstance } from "fastify";
import type { CommercialAdminService } from "../eligibility/admin-service";
import type { EligibilityService } from "../eligibility/service";
import { registerCommercialEligibilityRoutes } from "./eligibility.routes";
import { registerCommercialEnrollmentRoutes } from "./enrollment.routes";

export interface M41RouteServices {
  readonly eligibility: EligibilityService;
  readonly admin: CommercialAdminService;
}

export function mountM41Routes(app: FastifyInstance, services: M41RouteServices): void {
  registerCommercialEligibilityRoutes(app, services);
  registerCommercialEnrollmentRoutes(app, { admin: services.admin });
}
