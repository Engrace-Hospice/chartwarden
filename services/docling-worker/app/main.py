"""WardenX docling-worker — DocLens stage 2 (parse). See ../README.md.

POST /parse  {job_id, source_url}  →  {job_id, docling_version, page_count, pages:[...]}
GET  /health                       →  {status}

Security posture:
  * Every /parse call needs ``Authorization: Bearer <DOCLING_WORKER_TOKEN>`` (System Design §5.5; a
    worker-specific secret, NOT the backend's INTERNAL_SERVICE_TOKEN, so this container holds nothing
    that could authenticate TO the backend),
    compared in constant time. No token configured ⇒ the service refuses every call (fail closed).
  * The source is fetched from a short-lived presigned URL the backend minted, so this service holds no
    object-store credentials. Downloads are size-capped.
  * Nothing PHI is logged: no document text, no URL (a presigned URL is a bearer credential). Logs carry
    the job id, correlation id, page count and timings only.
"""

from __future__ import annotations

import hmac
import logging
import os
import tempfile
import time
from functools import lru_cache
from typing import Any, Callable

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .layout import document_to_pages

log = logging.getLogger("docling-worker")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())

MAX_SOURCE_BYTES = int(os.environ.get("DOCLING_MAX_SOURCE_BYTES", str(50 * 1024 * 1024)))
FETCH_TIMEOUT_S = float(os.environ.get("DOCLING_FETCH_TIMEOUT_S", "30"))
MAX_PAGES = int(os.environ.get("DOCLING_MAX_PAGES", "200"))


class ParseRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    source_url: str = Field(min_length=1, max_length=8192)


def require_service_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("DOCLING_WORKER_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="DOCLING_WORKER_TOKEN is not configured")
    presented = (authorization or "").removeprefix("Bearer ").strip()
    if not presented or not hmac.compare_digest(presented.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="invalid service token")


Converter = Callable[[str], Any]


@lru_cache(maxsize=1)
def _docling_converter() -> Converter:
    # Imported lazily: Docling pulls torch and its layout models, which tests never need.
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    options = PdfPipelineOptions()
    artifacts = os.environ.get("DOCLING_ARTIFACTS_PATH")
    if artifacts:
        options.artifacts_path = artifacts  # the models baked into the image; never a runtime download
    options.do_ocr = True  # faxes are images of text
    options.do_table_structure = True
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        }
    )

    def convert(path: str) -> Any:
        return converter.convert(path, max_num_pages=MAX_PAGES).document

    return convert


def get_converter() -> Converter:
    return _docling_converter()


def docling_version() -> str:
    try:
        from importlib.metadata import version

        return version("docling")
    except Exception:  # noqa: BLE001 — version is informational
        return "unknown"


def _download(url: str) -> bytes:
    with httpx.stream("GET", url, timeout=FETCH_TIMEOUT_S, follow_redirects=False) as res:
        if res.status_code != 200:
            raise HTTPException(status_code=502, detail=f"source fetch failed with HTTP {res.status_code}")
        chunks: list[bytes] = []
        size = 0
        for chunk in res.iter_bytes():
            size += len(chunk)
            if size > MAX_SOURCE_BYTES:
                raise HTTPException(status_code=413, detail="source exceeds the size limit")
            chunks.append(chunk)
    return b"".join(chunks)


def _suffix(data: bytes) -> str:
    if data.startswith(b"%PDF"):
        return ".pdf"
    if data.startswith(b"\x89PNG"):
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return ".tiff"
    raise HTTPException(status_code=415, detail="unsupported source type (PDF, PNG, JPEG or TIFF)")


app = FastAPI(title="WardenX docling-worker", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/parse", dependencies=[Depends(require_service_token)])
def parse(
    req: ParseRequest,
    converter: Converter = Depends(get_converter),
    x_correlation_id: str | None = Header(default=None),
) -> dict[str, Any]:
    started = time.monotonic()
    data = _download(req.source_url)
    suffix = _suffix(data)
    with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
        tmp.write(data)
        tmp.flush()
        try:
            doc = converter(tmp.name)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — Docling raises many types; the class is enough
            log.warning(
                "parse failed job=%s corr=%s error=%s", req.job_id, x_correlation_id, type(exc).__name__
            )
            raise HTTPException(status_code=422, detail="docling_parse_failed") from exc
    pages = document_to_pages(doc)
    log.info(
        "parsed job=%s corr=%s pages=%d blocks=%d ms=%d",
        req.job_id,
        x_correlation_id,
        len(pages),
        sum(len(p["blocks"]) for p in pages),
        int((time.monotonic() - started) * 1000),
    )
    return {
        "job_id": req.job_id,
        "docling_version": docling_version(),
        "page_count": len(pages),
        "pages": pages,
    }
