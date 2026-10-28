"""Golden corpus, malformed-input and timeout cases (CW-QA-0010). Real pdfium/Pillow over committed
fixtures; the Docling converter stays injected (same rule as the other tests)."""

from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.render import RenderError, render_page

CORPUS = Path(__file__).parent / "fixtures" / "corpus"
AUTH = {"Authorization": "Bearer " + "t" * 40}
BODY = {"job_id": "j1", "source_url": "http://x"}


@pytest.fixture
def serve(monkeypatch):
    monkeypatch.setenv("DOCLING_WORKER_TOKEN", "t" * 40)
    client = TestClient(main.app)

    def _serve(data: bytes) -> TestClient:
        monkeypatch.setattr(main, "_download", lambda url: data)
        return client

    yield _serve
    main.app.dependency_overrides.clear()


def _empty_doc():
    return SimpleNamespace(pages={}, iterate_items=lambda: [])


def test_golden_pdf_renders_each_page_at_its_own_geometry():
    pdf = (CORPUS / "two-page.pdf").read_bytes()
    first, second = render_page(pdf, 1, 1.0, None), render_page(pdf, 2, 1.0, None)
    assert (first.page_width, first.page_height) == (612, 792)
    assert (second.page_width, second.page_height) == (300, 400)
    assert Image.open(io.BytesIO(first.png)).size == (612, 792)


def test_golden_image_is_accepted_by_parse_and_render(serve):
    client = serve((CORPUS / "blank.png").read_bytes())
    main.app.dependency_overrides[main.get_converter] = lambda: (lambda path: _empty_doc())
    assert client.post("/parse", json=BODY, headers=AUTH).status_code == 200
    res = client.post("/render", json={**BODY, "page": 1}, headers=AUTH)
    assert res.status_code == 200 and res.headers["X-Page-Width"] == "120.00"


@pytest.mark.parametrize("data", [b"", b"\x00" * 64, b"<html>not a document</html>", b"GIF89a...."])
def test_malformed_sources_are_refused_as_415(serve, data):
    client = serve(data)
    main.app.dependency_overrides[main.get_converter] = lambda: (lambda path: _empty_doc())
    assert client.post("/parse", json=BODY, headers=AUTH).status_code == 415
    assert client.post("/render", json={**BODY, "page": 1}, headers=AUTH).status_code == 415


def test_truncated_pdf_is_a_422_on_render_not_a_crash(serve):
    truncated = (CORPUS / "two-page.pdf").read_bytes()[:40]
    with pytest.raises(RenderError):
        render_page(truncated, 1, 1.0, None)
    res = serve(truncated).post("/render", json={**BODY, "page": 1}, headers=AUTH)
    assert res.status_code == 422


def test_fetch_timeout_is_a_504_not_a_hang_or_500(monkeypatch):
    seen = {}

    def slow(method, url, timeout, follow_redirects):
        seen["timeout"] = timeout
        raise httpx.ReadTimeout("slow")

    monkeypatch.setattr(main.httpx, "stream", slow)
    with pytest.raises(main.HTTPException) as err:
        main._download("http://x")
    assert err.value.status_code == 504 and seen["timeout"] == main.FETCH_TIMEOUT_S


def test_fetch_connection_error_is_a_502(monkeypatch):
    def down(*a, **k):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(main.httpx, "stream", down)
    with pytest.raises(main.HTTPException) as err:
        main._download("http://x")
    assert err.value.status_code == 502
