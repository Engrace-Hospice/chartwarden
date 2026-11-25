"""OCR engine choice: Tesseract primary, RapidOCR backup. Docling is never imported: _converter_for is faked."""

from __future__ import annotations

import pytest

from app import main


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.delenv("DOCLING_OCR_ENGINE", raising=False)
    monkeypatch.delenv("DOCLING_OCR_BACKUP", raising=False)
    main._docling_converter.cache_clear()
    yield
    main._docling_converter.cache_clear()


def _fake_converters(monkeypatch, failing=()):
    built, calls = [], []

    def converter_for(engine):
        built.append(engine)

        def convert(path):
            calls.append(engine)
            if engine in failing:
                raise RuntimeError("patient name must never reach a log")
            return f"doc-from-{engine}"

        return convert

    monkeypatch.setattr(main, "_converter_for", converter_for)
    return built, calls


def test_defaults_are_tesseract_then_rapidocr(monkeypatch):
    built, calls = _fake_converters(monkeypatch)
    assert main._docling_converter()("x.pdf") == "doc-from-tesseract"
    assert calls == ["tesseract"]
    assert built == ["tesseract"]  # the backup is built only when it is needed


def test_backup_parses_the_document_when_the_primary_raises(monkeypatch, caplog):
    built, calls = _fake_converters(monkeypatch, failing=("tesseract",))
    with caplog.at_level("WARNING", logger="docling-worker"):
        assert main._docling_converter()("x.pdf") == "doc-from-rapidocr"
    assert calls == ["tesseract", "rapidocr"]
    assert "tesseract failed (RuntimeError)" in caplog.text
    assert "patient name" not in caplog.text  # the class is logged, never the message


def test_a_failing_backup_still_fails_the_parse(monkeypatch):
    _fake_converters(monkeypatch, failing=("tesseract", "rapidocr"))
    with pytest.raises(RuntimeError):
        main._docling_converter()("x.pdf")


def test_backup_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("DOCLING_OCR_BACKUP", "none")
    _, calls = _fake_converters(monkeypatch, failing=("tesseract",))
    with pytest.raises(RuntimeError):
        main._docling_converter()("x.pdf")
    assert calls == ["tesseract"]


def test_a_backup_equal_to_the_primary_runs_once(monkeypatch):
    monkeypatch.setenv("DOCLING_OCR_BACKUP", "tesseract")
    _, calls = _fake_converters(monkeypatch, failing=("tesseract",))
    with pytest.raises(RuntimeError):
        main._docling_converter()("x.pdf")
    assert calls == ["tesseract"]


@pytest.mark.parametrize("name", ["DOCLING_OCR_ENGINE", "DOCLING_OCR_BACKUP"])
def test_an_unknown_engine_is_refused(monkeypatch, name):
    monkeypatch.setenv(name, "abbyy")
    _fake_converters(monkeypatch)
    with pytest.raises(ValueError, match=name):
        main._docling_converter()


@pytest.mark.parametrize("name", ["DOCLING_OCR_ENGINE", "DOCLING_OCR_BACKUP"])
def test_an_empty_value_means_the_default_for_both(monkeypatch, name):
    monkeypatch.setenv(name, "  ")
    _, calls = _fake_converters(monkeypatch, failing=("tesseract",))
    assert main._docling_converter()("x.pdf") == "doc-from-rapidocr"  # the backup is still on
    assert calls == ["tesseract", "rapidocr"]


def test_none_is_only_for_the_backup(monkeypatch):
    monkeypatch.setenv("DOCLING_OCR_ENGINE", "none")
    _fake_converters(monkeypatch)
    with pytest.raises(ValueError, match="DOCLING_OCR_ENGINE"):
        main._docling_converter()


def test_the_fallback_warning_carries_the_request_ids(monkeypatch, caplog):
    _fake_converters(monkeypatch, failing=("tesseract",))
    token = main._request_ids.set("job=j-1 corr=c-1")
    try:
        with caplog.at_level("WARNING", logger="docling-worker"):
            main._docling_converter()("x.pdf")
    finally:
        main._request_ids.reset(token)
    assert "job=j-1 corr=c-1" in caplog.text
