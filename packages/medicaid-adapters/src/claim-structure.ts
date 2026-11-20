import type { MedicaidClaimKind } from "./contracts";

export type ClaimStructureFailure =
  | "rb_arrangement_forbidden"
  | "rb_arrangement_required"
  | "hospice_lines_required"
  | "rb_lines_required"
  | "hospice_lines_forbidden"
  | "rb_lines_forbidden";

/** Structural line-family contract. This does not establish payer responsibility or a state's claim format. */
export function claimStructureFailure(input: {
  readonly kind: MedicaidClaimKind;
  readonly hasRbArrangement: boolean;
  readonly hospiceLineCount: number;
  readonly rbLineCount: number;
}): ClaimStructureFailure | null {
  const { kind, hasRbArrangement, hospiceLineCount, rbLineCount } = input;

  switch (kind) {
    case "hospice_only":
      if (hasRbArrangement) return "rb_arrangement_forbidden";
      if (rbLineCount > 0) return "rb_lines_forbidden";
      if (hospiceLineCount < 1) return "hospice_lines_required";
      return null;
    case "rb_only":
      if (!hasRbArrangement) return "rb_arrangement_required";
      if (hospiceLineCount > 0) return "hospice_lines_forbidden";
      if (rbLineCount < 1) return "rb_lines_required";
      return null;
    case "combined_hospice_rb":
      if (!hasRbArrangement) return "rb_arrangement_required";
      if (hospiceLineCount < 1) return "hospice_lines_required";
      if (rbLineCount < 1) return "rb_lines_required";
      return null;
  }
}
