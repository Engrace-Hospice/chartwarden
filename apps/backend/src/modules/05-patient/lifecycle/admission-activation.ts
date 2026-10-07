// M5's patient-lifecycle decision for an admission that M6 has activated.  M6 owns the admission
// fact; M5 owns whether that fact can move its patient chart back into the active lifecycle.

export type PatientStatus =
  | "prospective"
  | "active"
  | "on_hold"
  | "discharged"
  | "deceased"
  | "merged";

export type AdmissionActivationTransition =
  | {
      readonly kind: "activate";
      readonly fromStatus: "prospective" | "discharged";
    }
  | { readonly kind: "already_active" };

/** Thrown rather than silently reopening a chart from a lifecycle state with no M6-admission edge. */
export class InvalidAdmissionActivationPatientStatusError extends Error {
  constructor(
    readonly patientId: string,
    readonly fromStatus: string,
  ) {
    super(
      `patient '${patientId}': cannot activate from status '${fromStatus}' on admission activation`,
    );
    this.name = "InvalidAdmissionActivationPatientStatusError";
  }
}

/**
 * Resolve M5 §2.4.1's admission-driven edges.  `on_hold → active` is deliberately not included:
 * it is the distinct "resume" edge for an existing election, not an activation of a new admission.
 */
export function transitionPatientOnAdmissionActivated(
  patientId: string,
  status: PatientStatus,
): AdmissionActivationTransition {
  switch (status) {
    case "prospective":
    case "discharged":
      return { kind: "activate", fromStatus: status };
    case "active":
      return { kind: "already_active" };
    case "on_hold":
    case "deceased":
    case "merged":
      throw new InvalidAdmissionActivationPatientStatusError(patientId, status);
  }
}
