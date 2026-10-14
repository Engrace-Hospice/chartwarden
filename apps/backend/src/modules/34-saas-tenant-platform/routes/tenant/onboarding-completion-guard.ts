// A tenant org_admin may mark an onboarding step done by hand only when the platform has nothing to verify about it.
// Steps with a `precondition_dsl` are settled by the advance worker from observed facts, and platform_ops-owned steps
// are the platform's to settle; letting the tenant write `done` on either would let it satisfy the activation guard
// itself (the sweep activates a tenant once every canonical step reads done or skipped).
export function tenantMayCompleteStep(template: {
  readonly requiredRole: string;
  readonly preconditionDsl: string | null;
}): boolean {
  return template.requiredRole !== "platform_ops" && template.preconditionDsl === null;
}
