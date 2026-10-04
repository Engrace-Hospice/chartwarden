"""Shape a Docling ``DoclingDocument`` into the WardenX ``/parse`` response (pure, no IO).

The DocLens extractor (M32) never trusts a model-reported coordinate. It asks the model for a VERBATIM
quote, finds that quote in the text blocks returned here, and takes the bounding box from the block it
matched. So this module's one job is to hand back every piece of text Docling found, each with the page
it is on and a box in a single, stated coordinate system:

    origin top-left, units = PDF points of that page, box = [left, top, right, bottom]

Docling's own boxes may be bottom-left-origin; every box is normalised here so the backend never has to
know which convention a given Docling version used.

Duck-typed on purpose: the function reads only ``pages``, ``iterate_items()``, ``text``, ``prov``,
``data.table_cells`` and ``bbox.to_top_left_origin()``, so it is unit-tested with plain stand-ins and
without importing Docling (and its multi-gigabyte model stack).
"""

from __future__ import annotations

from typing import Any


def _box(bbox: Any, page_height: float) -> list[float] | None:
    if bbox is None:
        return None
    tl = bbox.to_top_left_origin(page_height=page_height)
    left, top, right, bottom = float(tl.l), float(tl.t), float(tl.r), float(tl.b)
    # A degenerate or inverted box cannot be highlighted; drop it rather than ship a wrong highlight.
    if right <= left or bottom <= top:
        return None
    return [round(left, 2), round(top, 2), round(right, 2), round(bottom, 2)]


def document_to_pages(doc: Any) -> list[dict[str, Any]]:
    """Return ``[{page, width, height, blocks: [{text, bbox, label}]}]`` in page order."""
    pages: dict[int, dict[str, Any]] = {}
    for page_no, page in sorted(doc.pages.items()):
        pages[int(page_no)] = {
            "page": int(page_no),
            "width": float(page.size.width),
            "height": float(page.size.height),
            "blocks": [],
        }

    for item, _level in doc.iterate_items():
        label = str(getattr(item, "label", "text"))
        cells = getattr(getattr(item, "data", None), "table_cells", None)
        if cells is not None:
            # Tables: one block per cell, so a value inside a table still grounds to its own cell box.
            prov = (getattr(item, "prov", None) or [None])[0]
            page_no = int(prov.page_no) if prov is not None else None
            if page_no is None or page_no not in pages:
                continue
            for cell in cells:
                text = (getattr(cell, "text", "") or "").strip()
                box = _box(getattr(cell, "bbox", None), pages[page_no]["height"])
                if text and box:
                    pages[page_no]["blocks"].append({"text": text, "bbox": box, "label": "table_cell"})
            continue

        text = (getattr(item, "text", "") or "").strip()
        if not text:
            continue
        for prov in getattr(item, "prov", None) or []:
            page_no = int(prov.page_no)
            if page_no not in pages:
                continue
            box = _box(prov.bbox, pages[page_no]["height"])
            if box:
                pages[page_no]["blocks"].append({"text": text, "bbox": box, "label": label})

    return [pages[k] for k in sorted(pages)]
