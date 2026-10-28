"""docling-worker tests — no Docling import: the converter is injected, the document is a stand-in."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.layout import document_to_pages

TOKEN = "t" * 40


class Box:
    """A bottom-left-origin box, like Docling's PDF backend produces."""

    def __init__(self, l, t, r, b):  # noqa: E741
        self.l, self.t, self.r, self.b = l, t, r, b

    def to_top_left_origin(self, page_height):
        return SimpleNamespace(l=self.l, t=page_height - self.t, r=self.r, b=page_height - self.b)


def fake_doc():
    text = SimpleNamespace(
        label="text",
        text="Home phone: (503) 555-0142",
        prov=[SimpleNamespace(page_no=1, bbox=Box(72, 700, 300, 688))],
    )
    blank = SimpleNamespace(label="text", text="   ", prov=[SimpleNamespace(page_no=1, bbox=Box(1, 2, 3, 1))])
    table = SimpleNamespace(
        label="table",
        prov=[SimpleNamespace(page_no=2, bbox=Box(0, 0, 1, 1))],
        data=SimpleNamespace(
            table_cells=[
                SimpleNamespace(text="City", bbox=Box(72, 500, 120, 488)),
                SimpleNamespace(text="Salem", bbox=Box(130, 500, 200, 488)),
                SimpleNamespace(text="", bbox=Box(1, 2, 3, 1)),
            ]
        ),
    )
    return SimpleNamespace(
        pages={
            1: SimpleNamespace(size=SimpleNamespace(width=612, height=792)),
            2: SimpleNamespace(size=SimpleNamespace(width=612, height=792)),
        },
        iterate_items=lambda: [(text, 0), (blank, 0), (table, 0)],
    )


def test_document_to_pages_normalises_to_top_left_and_splits_table_cells():
    pages = document_to_pages(fake_doc())
    assert [p["page"] for p in pages] == [1, 2]
    assert pages[0]["blocks"] == [
        {"text": "Home phone: (503) 555-0142", "bbox": [72.0, 92.0, 300.0, 104.0], "label": "text"}
    ]
    assert [b["text"] for b in pages[1]["blocks"]] == ["City", "Salem"]
    assert pages[1]["blocks"][1]["bbox"] == [130.0, 292.0, 200.0, 304.0]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DOCLING_WORKER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "_download", lambda url: b"%PDF-1.7 fake")
    main.app.dependency_overrides[main.get_converter] = lambda: (lambda path: fake_doc())
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_parse_requires_the_service_token(client):
    res = client.post("/parse", json={"job_id": "j1", "source_url": "http://x"})
    assert res.status_code == 401
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": "Bearer nope"}
    )
    assert res.status_code == 401


def test_parse_refuses_when_no_token_is_configured(client, monkeypatch):
    monkeypatch.delenv("DOCLING_WORKER_TOKEN")
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 503


def test_parse_returns_pages(client):
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["job_id"] == "j1" and body["page_count"] == 2
    assert body["pages"][0]["blocks"][0]["text"].startswith("Home phone")


def test_parse_rejects_an_unsupported_source(client, monkeypatch):
    monkeypatch.setattr(main, "_download", lambda url: b"GIF89a....")
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 415


def test_parse_failure_is_a_422_without_the_message(client):
    def boom(path):
        raise RuntimeError("page 3 says: Jane Doe DOB 1/1/40")  # PHI in an exception must not leak

    main.app.dependency_overrides[main.get_converter] = lambda: boom
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 422
    assert "Jane" not in res.text


# --- #853: oversized / malformed documents and dependency floors ---------------------------------------------


class _FakeStream:
    status_code = 200

    def __init__(self, chunks):
        self._chunks = chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_bytes(self):
        return iter(self._chunks)


def test_download_rejects_an_oversized_source_with_413(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(main, "MAX_SOURCE_BYTES", 10)
    monkeypatch.setattr(main.httpx, "stream", lambda *a, **k: _FakeStream([b"%PDF" + b"x" * 4, b"y" * 8]))
    with pytest.raises(HTTPException) as err:
        main._download("http://x")
    assert err.value.status_code == 413


@pytest.mark.parametrize("body", [b"", b"%PD", b"\x00\x01\x02\x03", b"<html>not a document</html>", b"PK\x03\x04zip"])
def test_parse_rejects_malformed_or_unknown_content_with_415(client, monkeypatch, body):
    monkeypatch.setattr(main, "_download", lambda url: body)
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 415


def test_parse_of_a_truncated_pdf_is_a_422(client):
    def corrupt(path):
        raise ValueError("PDF parse error: truncated xref")

    main.app.dependency_overrides[main.get_converter] = lambda: corrupt
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 422 and res.json()["detail"] == "docling_parse_failed"
    assert "truncated xref" not in res.text


def test_parse_route_returns_413_for_an_oversized_source(client, monkeypatch):
    from fastapi import HTTPException

    def too_big(url):
        raise HTTPException(status_code=413, detail="source exceeds the size limit")

    monkeypatch.setattr(main, "_download", too_big)
    res = client.post(
        "/parse", json={"job_id": "j1", "source_url": "http://x"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert res.status_code == 413


def test_pillow_is_at_the_patched_major():
    # Every pillow 12.x carries fixable image-parsing CVEs (fixed in 13.0.0); uv.lock must not regress below it.
    from importlib.metadata import version

    assert int(version("pillow").split(".")[0]) >= 13
