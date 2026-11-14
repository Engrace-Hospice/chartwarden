# Intake Workspace User Guide

The Intake Workspace guides a referral from receipt through patient matching and admission handoff.
It does not replace ChartWarden's clinical, signature, privacy, or admission-readiness controls.

## Start or resume intake

1. Open **Admissions → Intake**.
2. Select the referral's **Next action**, or choose **New intake** for a new referral.
3. Use the stage tracker to see completed work and the current task. A completed stage can be
   revisited without changing the referral's canonical status.

The workspace reconstructs its stage from saved referral, patient, admission, and readiness data.
Refreshing the page or returning through a saved deep link does not create a second workflow.

## Complete the referral workflow

### Receive and verify

- Review the referral information and attached source documents.
- Correct highlighted fields before continuing. Validation messages appear beside the field and the
  primary action moves focus to the first unresolved field.
- An extraction suggestion is not verified clinical data until a user reviews it. If extraction is
  unavailable, use the manual fields and existing document upload path.

### Match the patient

- Review possible matches before confirming an existing patient.
- Choose **Create new patient** only after checking the candidates. Creation uses the existing
  duplicate and idempotency controls.
- If a required demographic value is missing, return to **Verify information**, save it, and then
  resume matching.

### Review and hand off

- The review stage lists referral and coverage blockers reported by the server.
- **Start admission** uses the existing referral-to-admission transition. Repeated submission does
  not intentionally create another admission; if the result is uncertain, reload the referral
  before trying again.
- After handoff, use the admission readiness cockpit to complete admission requirements.

## Understand admission readiness

The cockpit groups the server's requirements into:

- **Admission setup and privacy** — identity, admission details, and privacy clearance.
- **Notices, election, and certification** — Notice of Rights, election documents, CTI, and the
  election addendum when applicable.
- **Timing and clinical follow-up** — clinical recommendation and Face-to-Face work.

Every item shows its status, the server-provided reason, a suggested owner, and a corrective action
when ChartWarden has a supported destination. The suggested owner is workflow guidance supplied by
the interface, not a server assignment or authorization decision. A requirement can be advisory
without blocking activation. Unknown future actions remain visible but unavailable instead of
silently doing nothing.

The displayed deadline or exception language comes from the server. Do not infer a clinical deadline
from the grouping or the order of cards.

### Face-to-Face corrective work

Choose **Review face-to-face requirements** to open the patient's **Election & Certification**
workspace at the benefit-period and Face-to-Face section. The destination retains the existing role,
attestation, timing-window, and exception controls.

## When admission cannot advance

1. Read **Admission cannot be activated** for the current blocking reasons.
2. Open the corrective action on the relevant readiness card.
3. Complete the existing ceremony or clinical workflow.
4. Return to the admission and re-check readiness. Activation re-evaluates the same server gate; the
   browser cannot override it.

If a corrective action is marked unavailable, its adjacent explanation remains keyboard and screen
reader accessible. It means the server reported a requirement that this version of the workspace
cannot safely perform. Escalate it to the admission team rather than treating the item as complete.

## Accessibility and small screens

- Use the stage tracker, section links, and standard Tab/Shift+Tab navigation; all primary actions are
  keyboard reachable.
- Corrective navigation moves focus to the relevant destination heading.
- On narrow screens, content reflows into one column. Browser zoom does not change readiness rules or
  hide unresolved items.

## Support checklist

When reporting a problem, provide the referral or admission identifier, the visible requirement code
or label, and the exact error text. Do not include source documents, screenshots containing real PHI,
credentials, or copied clinical narrative in an issue.
