# Backend API and frontend

Added the M41 read-only payment reconciliation endpoint and generated its TypeBox/OpenAPI/client contract. The existing commercial claim detail displays current mutable charge, payer-reported CLP totals, M25-posted claim-line totals, per-advice status and receipt date. It explicitly labels the original submitted charge and canonical A/R unavailable and does not offer financial actions.

The existing Billing Operations summary distinguishes BPR, reported CLP, M25 posted claim-line effects, fully posted advice, partially posted advice, CAS, PLB and unmatched lines. It continues to state that A/R/aging is unavailable. UI currently shows no new advice-detail deep link because there is no M25 advice-detail destination in the existing web routes.
