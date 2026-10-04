"""Render one page of a source document to PNG — the DocLens review overlay and stage-5 crops (F-237).

POST /render returns a page image in the SAME coordinate system /parse reports boxes in (origin top-left,
units = the page's own units — PDF points for a PDF, pixels for a raster image), so a box from /parse can be
drawn on the image, or cropped from it, by multiplying by ``scale``.

``crop`` (optional) is ``[left, top, right, bottom]`` in page units; it is clamped to the page. A stage-5
vision check sends the model only the crop around one field, never the whole page.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

MAX_SCALE = 4.0
MAX_OUTPUT_PIXELS = 40_000_000  # ~ a letter page at 4x; refuses absurd requests rather than OOM


class RenderError(ValueError):
    """The request cannot be rendered (no such page, empty crop, oversized output)."""


@dataclass(frozen=True)
class RenderedPage:
    png: bytes
    page_width: float
    page_height: float
    scale: float


def _clamp_crop(
    crop: tuple[float, float, float, float] | None, width: float, height: float
) -> tuple[float, float, float, float] | None:
    if crop is None:
        return None
    left, top, right, bottom = crop
    left, top = max(0.0, left), max(0.0, top)
    right, bottom = min(width, right), min(height, bottom)
    if right - left < 1 or bottom - top < 1:
        raise RenderError("crop is empty after clamping to the page")
    return left, top, right, bottom


def _encode(image, crop_px) -> bytes:  # noqa: ANN001 — a PIL image
    if crop_px is not None:
        image = image.crop(crop_px)
    if image.width * image.height > MAX_OUTPUT_PIXELS:
        raise RenderError("rendered image is too large")
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def render_page(
    data: bytes,
    page: int,
    scale: float = 2.0,
    crop: tuple[float, float, float, float] | None = None,
) -> RenderedPage:
    """Render 1-based ``page`` of a PDF / PNG / JPEG / TIFF at ``scale`` (optionally cropped)."""
    if not 0.25 <= scale <= MAX_SCALE:
        raise RenderError(f"scale must be within [0.25, {MAX_SCALE}]")
    if page < 1:
        raise RenderError("page is 1-based")

    if data.startswith(b"%PDF"):
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(data)
        try:
            if page > len(pdf):
                raise RenderError("no such page")
            p = pdf[page - 1]
            width, height = p.get_size()
            box = _clamp_crop(crop, width, height)
            # Render the whole page at `scale` and crop in pixel space: pdfium's own crop arg trims in
            # points from each edge, and the arithmetic is easier to keep right in one place.
            image = p.render(scale=scale).to_pil()
        finally:
            pdf.close()
    else:
        from PIL import Image, ImageSequence

        source = Image.open(io.BytesIO(data))
        frames = list(ImageSequence.Iterator(source))
        if page > len(frames):
            raise RenderError("no such page")
        frame = frames[page - 1].copy()
        width, height = float(frame.width), float(frame.height)
        box = _clamp_crop(crop, width, height)
        image = frame.resize((max(1, round(width * scale)), max(1, round(height * scale))))

    crop_px = (
        None
        if box is None
        else tuple(round(v * scale) for v in box)  # type: ignore[assignment]
    )
    return RenderedPage(png=_encode(image, crop_px), page_width=width, page_height=height, scale=scale)
