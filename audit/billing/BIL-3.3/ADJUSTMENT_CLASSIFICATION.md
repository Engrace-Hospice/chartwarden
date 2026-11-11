# Adjustment classification

The read model carries each parsed CAS adjustment's original group and reason code. Group labels are presentation categories: CO contractual obligation, PR patient responsibility, OA other adjustment, PI payer-initiated reduction, CR correction/reversal; unknown groups are unsupported. These labels do not authorize write-off, liability transfer, reversal, or allocation.

Claim-level CAS, service-line CAS, and PLB values are separate fields. PLB is never distributed over claims. Existing remarks are not relabeled as CARC/RARC descriptions; the UI preserves available codes and displays “Description unavailable” because this phase does not add a maintained code dictionary.

No floating point is used for totals after conversion to minor units. A missing amount remains null and makes its aggregate unavailable rather than being treated as zero.
