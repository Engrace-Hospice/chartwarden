# Counts and pagination

The UI labels counts as loaded items and calls attention counts “loaded items”; a continuation is labeled “more available”. It does not imply a global total or cross-source snapshot. Each module retains its own authoritative cursor and sort order.

On continuation, rows are deduplicated by namespaced source identity. If a source request fails, its prior cursor and rows are retained so the source page can be retried; other sources may continue independently. Refresh resets the source pages. Changing provider or M25 filters reloads the list and invalidates old requests.

Counts remain page/loaded counts rather than exact category totals. Search remains limited to supported M25 payer/date/status server filters; no global reference search is advertised.
