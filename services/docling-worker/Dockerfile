# WardenX docling-worker — DocLens stage 2 (parse). CPU-only.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/models/hf DOCLING_ARTIFACTS_PATH=/opt/models/docling

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY pyproject.toml ./
# CPU torch wheels first, so Docling does not pull the multi-gigabyte CUDA build.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
 && pip install ".[docling]" easyocr

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
