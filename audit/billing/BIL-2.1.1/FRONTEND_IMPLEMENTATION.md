# Frontend

The M23 editor now shows a renderer-derived review summary (TOB, service dates, line count and total) and displays safe renderer gaps with an accessible alert. Submit eligibility is false if the renderer is blocked. It continues to state that the final X12 digest is recorded at send time; it does not display a digest, MBI, TIN, or raw X12.

The editor still uses its local preparation response type and `as never` workaround for the generated API client call. This inherited type-depth workaround was not replaced in this sub-phase. There is no token refresh/review confirmation interaction yet because the server-side token contract is not implemented. The summary is intentionally not presented as immutable final-send confirmation.
