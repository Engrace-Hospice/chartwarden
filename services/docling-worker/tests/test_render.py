"""/render tests — real pdfium + Pillow over generated documents (no Docling import)."""

from __future__ import annotations

import io

import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.render import RenderError, render_page

TOKEN = "t" * 40


def letter_pdf(pages: int = 2) -> bytes:
    pdf = pdfium.PdfDocument.new()
    for _ in range(pages):
        pdf.new_page(612, 792)
    buf = io.BytesIO()
    pdf.save(buf)
    pdf.close()
    return buf.getvalue()


def png_size(data: bytes) -> tuple[int, int]:
    return Image.open(io.BytesIO(data)).size


def test_renders_a_pdf_page_in_page_units_times_scale():
    out = render_page(letter_pdf(), page=2, scale=2)
    assert (out.page_width, out.page_height) == (612, 792)
    assert png_size(out.png) == (1224, 1584)


def test_crop_is_in_page_units_and_clamped_to_the_page():
    out = render_page(letter_pdf(), page=1, scale=3, crop=(72, 72, 172, 122))
    assert png_size(out.png) == (300, 150)
    edge = render_page(letter_pdf(), page=1, scale=1, crop=(600, 780, 700, 900))
    assert png_size(edge.png) == (12, 12)  # clamped at 612 x 792


def test_a_raster_page_uses_pixels_as_page_units():
    buf = io.BytesIO()
    Image.new("L", (100, 50), 255).save(buf, format="PNG")
    out = render_page(buf.getvalue(), page=1, scale=2, crop=(10, 10, 60, 30))
    assert (out.page_width, out.page_height) == (100, 50)
    assert png_size(out.png) == (100, 40)


@pytest.mark.parametrize(
    "kwargs",
    [{"page": 3}, {"page": 0}, {"page": 1, "scale": 9}, {"page": 1, "crop": (700, 0, 800, 10)}],
)
def test_refuses_what_it_cannot_render(kwargs):
    with pytest.raises(RenderError):
        render_page(letter_pdf(), **kwargs)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DOCLING_WORKER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "_download", lambda url: letter_pdf())
    return TestClient(main.app)


def test_render_route_returns_png_with_page_geometry(client):
    res = client.post(
        "/render",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"job_id": "b1", "source_url": "https://minio/x", "page": 1, "scale": 1.5},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.headers["x-page-width"] == "612.00"
    assert res.headers["x-page-height"] == "792.00"
    assert res.headers["cache-control"] == "no-store"
    assert png_size(res.content) == (918, 1188)


def test_render_route_needs_the_token_and_a_real_page(client):
    body = {"job_id": "b1", "source_url": "https://minio/x", "page": 1}
    assert client.post("/render", json=body).status_code == 401
    res = client.post(
        "/render", headers={"Authorization": f"Bearer {TOKEN}"}, json={**body, "page": 5}
    )
    assert res.status_code == 422


def test_concurrent_renders_never_overlap_inside_pdfium(monkeypatch):
    # The review screen and stage-5 crops hit /render in parallel on FastAPI's threadpool; unserialised
    # pdfium calls failed ("Failed to load page") and segfaulted the worker (F-238 E2E). The race itself is
    # intermittent, so this asserts the invariant instead: at most one thread is ever inside pdfium.
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    real = pdfium.PdfDocument
    state = {"inside": 0, "peak": 0}
    guard = threading.Lock()

    class Tracked(real):  # type: ignore[misc, valid-type]
        def __init__(self, *a, **k):
            with guard:
                state["inside"] += 1
                state["peak"] = max(state["peak"], state["inside"])
            time.sleep(0.01)  # widen the window an unserialised render would overlap in
            super().__init__(*a, **k)

        def close(self):
            super().close()
            with guard:
                state["inside"] -= 1

    monkeypatch.setattr(pdfium, "PdfDocument", Tracked)
    data = letter_pdf(4)
    with ThreadPoolExecutor(max_workers=8) as pool:
        outs = list(pool.map(lambda i: render_page(data, page=i % 4 + 1, scale=1), range(32)))
    assert {png_size(o.png) for o in outs} == {(612, 792)}
    assert state["peak"] == 1
