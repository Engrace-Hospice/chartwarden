# ChartWarden docling-worker — DocLens stage 2 (parse). CPU-only.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/models/hf DOCLING_ARTIFACTS_PATH=/opt/models/docling

# libcurl4t64 is named so the layer is rebuilt against the current security repo: tesseract pulls it in, and a
# cached older layer kept the vulnerable 8.14.1-2+deb13u5 (CVE-2026-8286, CVE-2026-8927; fixed in deb13u7).
# libexpat1 is named for the same reason: the base image ships 2.8.3-1~deb13u1 (CVE-2026-66046, -76956, -76957,
# -77214, -93990; fixed in 2.9.0-1~deb13u1), and naming it makes apt upgrade it in place.
# libbrotli1 is named for the same reason: the base image ships 1.1.0-2+b7 (CVE-2026-111497; fixed in 1.1.0-2+deb13u1).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libbrotli1 libcurl4t64 libexpat1 libgl1 libglib2.0-0 tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY pyproject.toml ./
# CPU torch wheels first, so Docling does not pull the multi-gigabyte CUDA build. Keep the packaging
# tools present in the runtime image above Trivy's fixed versions. filelock arrives transitively (torch,
# huggingface-hub) at 3.32.3 (CVE-2026-112940; fixed in 4.2.1), so it is lifted here with the rest.
# pillow 13 is forced with --no-deps: docling-core / docling-ibm-models / docling-parse still declare pillow<13, but
# every pillow 12.x carries fixable HIGH/CRITICAL image-parsing CVEs (fixed only in 13.0.0) in a path that parses
# patient documents. Drop the override once those packages lift the cap. (uv.lock is not used by this build and
# still records pillow 12.3.0; do not treat it as the shipped version.)
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
 && pip install ".[docling]" easyocr \
 && pip install --upgrade "jaraco.context>=6.1.0" "setuptools>=78.1.1" "wheel>=0.46.2" \
    "certifi>=2026.10.19" "filelock>=4.2.1" \
 && pip install --upgrade --no-deps "pillow>=13.0.0,<14"

# Bake the layout / table / OCR models into the image: a worker must not download models from the
# internet at request time (and must not need egress at all in production).
RUN docling-tools models download -o /opt/models/docling layout tableformer easyocr

COPY app ./app
# EasyOCR writes a per-user network dir under its module path at reader start-up; give it one.
ENV EASYOCR_MODULE_PATH=/opt/models/easyocr
RUN useradd --system --create-home --uid 10001 docling \
 && mkdir -p /opt/models/easyocr && chown -R docling /srv /opt/models
USER docling

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
