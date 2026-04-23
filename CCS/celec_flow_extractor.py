#!/usr/bin/env python3
"""
Extract daily flow values from CELEC monitoring PDFs.

The relevant chart is not consistently embedded as text. This script renders
or extracts likely chart images, sends them to Windows' offline OCR engine, and
selects the three Q.med values that satisfy:

    Rio Coca - Derivado CSS = Frente de erosion
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import fitz
import numpy as np
from PIL import Image

try:
    import pytesseract
except ImportError:
    pytesseract = None


DEFAULT_MANIFEST = Path("manifests") / "celec_pdfs_manifest.csv"
DEFAULT_OUTPUT = Path("outputs") / "celec_daily_flows.csv"
DEFAULT_TEMP_DIR = Path("tmp") / "flow_ocr"
DEFAULT_OCR_SCRIPT = Path("tools") / "windows_ocr.ps1"
DEFAULT_OCR_LANG = "spa"


@dataclass(frozen=True)
class PdfJob:
    report_date: dt.date
    pdf_path: Path
    remote_path: str


@dataclass(frozen=True)
class Candidate:
    path: Path
    pdf_path: Path
    source: str
    priority: int


@dataclass(frozen=True)
class FlowTriple:
    coca: float
    derivado_css: float
    frente_erosion: float
    error: float
    source: str
    ocr_text: str
    qmed_context: bool = False


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract Rio Coca, CSS, and erosion-front daily Q.med values."
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--temp-dir", type=Path, default=DEFAULT_TEMP_DIR)
    parser.add_argument("--ocr-script", type=Path, default=DEFAULT_OCR_SCRIPT,
                        help="Legacy: Windows.Media.Ocr PowerShell script. Used only if --ocr-engine=windows.")
    parser.add_argument("--ocr-engine", choices=["tesseract", "windows"], default="tesseract",
                        help="OCR backend. Default 'tesseract' is cross-platform.")
    parser.add_argument("--ocr-lang", default=DEFAULT_OCR_LANG,
                        help="Tesseract language code (default: spa).")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--since", help="YYYY-MM-DD")
    parser.add_argument("--until", help="YYYY-MM-DD")
    parser.add_argument("--only-missing", action="store_true")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--progress-every", type=int, default=25)
    return parser.parse_args(argv)


def read_manifest(path: Path) -> list[PdfJob]:
    jobs: list[PdfJob] = []
    with path.open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        for row in reader:
            report_date = dt.date.fromisoformat(row["report_date"])
            local_path = Path(row["local_path"])
            if not local_path.is_absolute():
                local_path = Path.cwd() / local_path
            jobs.append(
                PdfJob(
                    report_date=report_date,
                    pdf_path=local_path,
                    remote_path=row.get("remote_path", ""),
                )
            )
    return sorted(jobs, key=lambda job: (job.report_date, str(job.pdf_path)))


def read_existing_success(path: Path) -> set[Path]:
    if not path.exists():
        return set()
    done: set[Path] = set()
    with path.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            if row.get("status") == "ok":
                done.add(Path(row["pdf_path"]).resolve())
    return done


def extract_text_front_value(doc: fitz.Document) -> float | None:
    text = "\n".join(page.get_text("text") for page in doc)
    patterns = [
        r"Registro\s+diario\s+de\s+caudales\s+del\s+r[ií]o\s+Coca\s+en\s+el\s+frente\s+de\s+erosi[oó]n[\s\S]{0,220}?Caudal\s+medio\s*:?\s*([0-9]+(?:[,.][0-9]+)?)\s*m",
        r"caudal\s+medio\s+registrado\s+en\s+el\s+frente\s+de\s+erosi[oó]n\s+fue\s+(?:de\s+)?([0-9]+(?:[,.][0-9]+)?)\s*m",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return parse_number(match.group(1))
    return None


def prepare_temp_dir(temp_dir: Path) -> None:
    temp_dir.mkdir(parents=True, exist_ok=True)


def clean_pdf_temp(temp_dir: Path, pdf_key: str) -> None:
    for path in temp_dir.glob(f"{pdf_key}_*"):
        if path.is_file():
            path.unlink()


def slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Za-z0-9]+", "_", ascii_value).strip("_")[:80] or "pdf"


def generate_candidates(job: PdfJob, doc: fitz.Document, temp_dir: Path) -> list[Candidate]:
    pdf_key = f"{job.report_date.isoformat()}_{slug(job.pdf_path.stem)}"
    clean_pdf_temp(temp_dir, pdf_key)
    candidates: list[Candidate] = []

    for page_index, page in enumerate(doc):
        candidates.extend(extract_embedded_image_candidates(job, doc, page, page_index, temp_dir, pdf_key))

        # Full page OCR is a useful fallback for vector charts and old formats.
        rendered = render_page(page, zoom=2.2)
        page_path = temp_dir / f"{pdf_key}_p{page_index + 1}_full.png"
        rendered.save(page_path)
        candidates.append(Candidate(page_path, job.pdf_path, f"page{page_index + 1}:full", 80))

        for name, crop in render_common_crops(rendered):
            crop_path = temp_dir / f"{pdf_key}_p{page_index + 1}_{name}.png"
            crop.save(crop_path)
            candidates.append(Candidate(crop_path, job.pdf_path, f"page{page_index + 1}:{name}", 20))

    return candidates


def extract_embedded_image_candidates(
    job: PdfJob,
    doc: fitz.Document,
    page: fitz.Page,
    page_index: int,
    temp_dir: Path,
    pdf_key: str,
) -> list[Candidate]:
    candidates: list[Candidate] = []
    for image_index, image in enumerate(page.get_images(full=True), start=1):
        xref = image[0]
        width, height = image[2], image[3]
        if width < 420 or height < 180:
            continue

        rects = page.get_image_rects(xref)
        rect = rects[0] if rects else None
        if rect is not None and (rect.width < 80 or rect.height < 50):
            continue

        try:
            extracted = doc.extract_image(xref)
        except RuntimeError:
            continue

        raw_path = temp_dir / f"{pdf_key}_p{page_index + 1}_img{image_index}.png"
        raw_path.write_bytes(extracted["image"])
        try:
            prepared = prepare_ocr_image(Image.open(raw_path).convert("RGB"), max_width=1800)
        except OSError:
            continue

        prepared_path = temp_dir / f"{pdf_key}_p{page_index + 1}_img{image_index}_ocr.png"
        prepared.save(prepared_path)
        priority = 5 if likely_chart_size(width, height) else 50
        candidates.append(
            Candidate(
                prepared_path,
                job.pdf_path,
                f"page{page_index + 1}:image{xref}",
                priority,
            )
        )
    return candidates


def likely_chart_size(width: int, height: int) -> bool:
    ratio = width / max(1, height)
    return 1.4 <= ratio <= 3.8 and width >= 500 and height >= 250


def render_page(page: fitz.Page, zoom: float) -> Image.Image:
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def render_common_crops(page_image: Image.Image) -> Iterable[tuple[str, Image.Image]]:
    width, height = page_image.size
    boxes = {
        "top_right_chart": (0.48, 0.00, 0.52, 0.25),
        "mid_right_chart": (0.48, 0.42, 0.52, 0.30),
        "lower_right_chart": (0.48, 0.50, 0.52, 0.28),
        "bottom_right_chart": (0.52, 0.56, 0.47, 0.26),
        "wide_lower_chart": (0.42, 0.48, 0.58, 0.30),
        "bottom_band": (0.00, 0.55, 1.00, 0.30),
        "footer_right_chart": (0.50, 0.78, 0.50, 0.22),
        "footer_band": (0.00, 0.78, 1.00, 0.22),
    }
    for name, (x, y, w, h) in boxes.items():
        left = int(width * x)
        top = int(height * y)
        right = min(width, int(width * (x + w)))
        bottom = min(height, int(height * (y + h)))
        if right - left < 100 or bottom - top < 80:
            continue
        yield name, prepare_ocr_image(page_image.crop((left, top, right, bottom)), max_width=1800)


def prepare_ocr_image(image: Image.Image, max_width: int) -> Image.Image:
    width, height = image.size
    if width < 1000:
        scale = min(4.0, max_width / max(1, width))
    else:
        scale = min(2.0, max_width / max(1, width))
    if scale > 1.05:
        image = image.resize((int(width * scale), int(height * scale)), Image.Resampling.LANCZOS)
    return image


def run_ocr_batch(
    image_paths: list[Path],
    engine: str = "tesseract",
    ocr_script: Path | None = None,
    lang: str = DEFAULT_OCR_LANG,
) -> list[dict]:
    if not image_paths:
        return []
    if engine == "windows":
        return _run_ocr_batch_windows(ocr_script, image_paths)
    return _run_ocr_batch_tesseract(image_paths, lang=lang)


def _run_ocr_batch_tesseract(image_paths: list[Path], lang: str) -> list[dict]:
    if pytesseract is None:
        raise RuntimeError(
            "pytesseract no está instalado. Ejecuta: pip install pytesseract\n"
            "y asegúrate de tener Tesseract instalado en el sistema."
        )
    results: list[dict] = []
    config = "--psm 6"
    for image_path in image_paths:
        try:
            with Image.open(image_path) as img:
                img = img.convert("RGB")
                text = pytesseract.image_to_string(img, lang=lang, config=config)
                lines_data = []
                try:
                    data = pytesseract.image_to_data(
                        img, lang=lang, config=config,
                        output_type=pytesseract.Output.DICT,
                    )
                    for i in range(len(data.get("text", []))):
                        line_text = (data["text"][i] or "").strip()
                        if not line_text:
                            continue
                        try:
                            conf = float(data["conf"][i])
                        except (ValueError, TypeError):
                            conf = -1.0
                        if conf < 0:
                            continue
                        lines_data.append({
                            "text": line_text,
                            "x": int(data["left"][i]),
                            "y": int(data["top"][i]),
                            "w": int(data["width"][i]),
                            "h": int(data["height"][i]),
                            "conf": conf,
                        })
                except Exception:
                    pass
            results.append({
                "path": str(image_path.resolve()),
                "ok": True,
                "text": text,
                "lines": lines_data,
            })
        except Exception as exc:
            results.append({
                "path": str(image_path.resolve()),
                "ok": False,
                "text": "",
                "lines": [],
                "error": str(exc),
            })
    return results


def _run_ocr_batch_windows(ocr_script: Path | None, image_paths: list[Path]) -> list[dict]:
    if ocr_script is None or not ocr_script.exists():
        raise RuntimeError(f"OCR script no encontrado: {ocr_script}")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".txt") as file:
        list_path = Path(file.name)
        for image_path in image_paths:
            file.write(str(image_path.resolve()) + "\n")
    try:
        command = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(ocr_script.resolve()),
            "-InputList",
            str(list_path),
        ]
        completed = subprocess.run(
            command,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=True,
        )
        data = json.loads(completed.stdout or "[]")
        if isinstance(data, dict):
            return [data]
        return data
    finally:
        list_path.unlink(missing_ok=True)


def parse_ocr_result(result: dict, candidate: Candidate, front_text_value: float | None) -> FlowTriple | None:
    text = result.get("text", "") or ""
    lines = result.get("lines") or []
    line_text = "\n".join(str(line.get("text", "")) for line in lines)
    combined = text + "\n" + line_text

    if not looks_like_qmed_context(combined):
        return None

    triples = candidate_triples(combined)
    if not triples:
        return None
    has_qmed_values = len(extract_qmed_line_values(combined)) >= 3

    best: FlowTriple | None = None
    for coca, derivado, frente in triples:
        error = abs((coca - derivado) - frente)
        score = error
        if front_text_value is not None:
            score += min(10.0, abs(frente - front_text_value))
        if not looks_like_qmed_context(combined):
            score += 5.0
        score += candidate.priority * 0.001

        triple = FlowTriple(
            coca=coca,
            derivado_css=derivado,
            frente_erosion=frente,
            error=error,
            source=candidate.source,
            ocr_text=compact_text(combined),
            qmed_context=has_qmed_values,
        )
        if best is None or score < triple_score(best, front_text_value) + candidate.priority * 0.001:
            best = triple
    return best


def estimate_plot_triple(candidate: Candidate, front_text_value: float | None) -> FlowTriple | None:
    """Estimate flows from chart line positions when the Q.med box is absent."""
    if front_text_value is None or front_text_value <= 0:
        return None
    if not any(
        token in candidate.source
        for token in ("footer", "bottom", "lower", "image")
    ):
        return None

    try:
        image = np.asarray(Image.open(candidate.path).convert("RGB"))
    except OSError:
        return None

    height, width = image.shape[:2]
    if height < 250 or width < 500:
        return None

    red = image[:, :, 0].astype(int)
    green = image[:, :, 1].astype(int)
    blue = image[:, :, 2].astype(int)

    masks = {
        "red": (red > 130) & (red > green + 30) & (red > blue + 30) & (green < 175) & (blue < 175),
        "blue": (blue > 70) & (blue > red + 20) & (green > 25) & (red < 155),
        "green": (green > 70) & (green > red + 20) & (green > blue + 5) & (red < 175) & (blue < 185),
    }
    crop = (
        int(width * 0.05),
        int(height * 0.05),
        int(width * 0.95),
        int(height * 0.82),
    )
    line_y: dict[str, float] = {}
    line_counts: dict[str, int] = {}
    for color, mask in masks.items():
        y_value = horizontal_line_mean_y(mask, crop)
        if y_value is None:
            return None
        line_y[color] = y_value
        x0, y0, x1, y1 = crop
        line_counts[color] = int(mask[y0:y1, x0:x1].sum())

    # In these charts larger flows are higher on the image.
    if not (line_y["red"] < line_y["blue"] < line_y["green"]):
        return None

    pixel_gap = line_y["blue"] - line_y["red"]
    lower_gap = line_y["green"] - line_y["blue"]
    if pixel_gap < 8 or lower_gap < 5:
        return None
    if line_counts["green"] < max(120, min(line_counts["red"], line_counts["blue"]) * 0.2):
        return None
    if max(line_counts.values()) > min(line_counts.values()) * 15:
        return None

    scale = front_text_value / pixel_gap
    if not (0.02 <= scale <= 5.0):
        return None

    zero_y = line_y["green"] + front_text_value / scale
    coca = (zero_y - line_y["red"]) * scale
    derivado = (zero_y - line_y["blue"]) * scale
    frente = front_text_value
    error = abs((coca - derivado) - frente)

    if not valid_flow_triple(coca, derivado, frente):
        return None

    ocr_text = (
        "plot_fallback "
        f"red_y={line_y['red']:.2f} blue_y={line_y['blue']:.2f} green_y={line_y['green']:.2f} "
        f"pixels={line_counts}"
    )
    return FlowTriple(
        coca=round(coca, 2),
        derivado_css=round(derivado, 2),
        frente_erosion=round(frente, 2),
        error=error,
        source=f"{candidate.source}:plot_fallback",
        ocr_text=ocr_text,
        qmed_context=False,
    )


def horizontal_line_mean_y(mask: np.ndarray, crop: tuple[int, int, int, int]) -> float | None:
    x0, y0, x1, y1 = crop
    cropped = mask[y0:y1, x0:x1]
    ys, xs = np.where(cropped)
    if len(ys) < 120:
        return None

    per_column_y: list[float] = []
    for x in np.unique(xs):
        column_ys = ys[xs == x]
        if len(column_ys) >= 1:
            per_column_y.append(float(np.median(column_ys)) + y0)
    if len(per_column_y) < 80:
        return None
    return float(np.mean(per_column_y))


def triple_score(triple: FlowTriple, front_text_value: float | None) -> float:
    if triple.qmed_context:
        score = min(triple.error, 0.2)
    else:
        score = triple.error
    if front_text_value is not None:
        score += min(10.0, abs(triple.frente_erosion - front_text_value))
    if not looks_like_qmed_context(triple.ocr_text):
        score += 5.0
    return score


def looks_like_qmed_context(text: str) -> bool:
    normalized = normalize_ocr_text(text).lower()
    compact = re.sub(r"\s+", "", normalized)
    has_q_label = bool(re.search(r"(^|[^a-z])q([^a-z]|$)|q\s*[=:]|q[._-]?m", normalized))
    return (
        "qmed" in compact
        or "q.med" in normalized
        or "q_med" in normalized
        or (has_q_label and "hidrogramas" in normalized)
        or (has_q_label and "derivado" in normalized and "erosion" in normalized)
        or (has_q_label and "derivado" in normalized and "erosión" in normalized)
        or (has_q_label and "frente de erosion" in normalized)
        or (has_q_label and "frente de erosión" in normalized)
    )


def candidate_triples(text: str) -> list[tuple[float, float, float]]:
    qmed_values = extract_qmed_line_values(text)
    if len(qmed_values) == 3 and physically_plausible_values(*qmed_values):
        return [tuple(qmed_values)]
    if len(qmed_values) >= 3:
        ordered_qmed_triples = [
            tuple(qmed_values[i : i + 3])
            for i in range(0, len(qmed_values) - 2)
            if physically_plausible_values(*qmed_values[i : i + 3])
            and relaxed_balance_ok(*qmed_values[i : i + 3])
        ]
        if ordered_qmed_triples:
            return ordered_qmed_triples

    values = extract_numeric_values(text, include_integer_units=looks_like_qmed_context(text))
    triples: list[tuple[float, float, float]] = []

    for i in range(0, max(0, len(values) - 2)):
        triple = tuple(values[i : i + 3])
        if valid_flow_triple(*triple):
            triples.append(triple)

    # OCR can interleave nearby labels; allow sparse triples while preserving order.
    if not triples and len(values) <= 8:
        for i in range(len(values)):
            for j in range(i + 1, len(values)):
                for k in range(j + 1, len(values)):
                    triple = (values[i], values[j], values[k])
                    if valid_flow_triple(*triple):
                        triples.append(triple)
    if not triples and looks_like_qmed_context(text) and len(values) <= 8:
        for i in range(len(values)):
            for j in range(i + 1, len(values)):
                for k in range(j + 1, len(values)):
                    triple = (values[i], values[j], values[k])
                    if physically_plausible_values(*triple):
                        triples.append(triple)
    return triples


def extract_decimal_values(text: str) -> list[float]:
    return extract_numeric_values(text, include_integer_units=False)


def extract_numeric_values(text: str, include_integer_units: bool) -> list[float]:
    normalized = normalize_ocr_text(text)
    values: list[float] = []
    integer_unit = r"|(?<![\d/])(\d{1,4})(?![,.]\d)(?=\s*m(?:3|us|/|³))" if include_integer_units else ""
    pattern = rf"(?<![\d/])(\d{{1,4}}[,.][0-9oO]{{1,2}})(?![\d/]){integer_unit}"
    for match in re.finditer(pattern, normalized, flags=re.IGNORECASE):
        token = match.group(1)
        if not token and include_integer_units:
            token = match.group(2)
        if not token:
            continue
        value = parse_number(token)
        if 0 <= value <= 5000:
            values.append(value)
    return values


def extract_qmed_line_values(text: str) -> list[float]:
    values: list[float] = []
    for line in normalize_ocr_text(text).splitlines():
        marker_matches = list(qmed_marker_regex().finditer(line))
        if not marker_matches:
            continue
        for marker in marker_matches:
            line_values = extract_numeric_values(line[marker.end() :], include_integer_units=True)
            if line_values:
                values.append(line_values[0])
                break
    return values


def looks_like_qmed_line(line: str) -> bool:
    line = normalize_ocr_text(line).lower().replace(" ", "")
    return bool(qmed_marker_regex().search(line))


def qmed_marker_regex() -> re.Pattern[str]:
    return re.compile(r"q[._-]?m(?:e|3)(?:d|f|o)?|q[._-]?med|qme(?:d|f|o)?", re.IGNORECASE)


def normalize_ocr_text(text: str) -> str:
    replacements = {
        "\u00a0": " ",
        "rn3": "m3",
        "ma": "m3",
        "m³": "m3",
        "M3": "m3",
        "Ró": "Rio",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"(?<![A-Za-z])O(?=[,.][0-9oO])", "0", text)
    text = re.sub(r"(?<=[,.])[oO](?=\b|[^A-Za-z])", "0", text)
    text = re.sub(r"(?<=\d)['’´`](?=\d{1,2}\b)", ",", text)
    return text


def parse_number(value: str) -> float:
    value = value.strip().replace("O", "0").replace("o", "0")
    return float(value.replace(".", ",").replace(",", "."))


def valid_flow_triple(coca: float, derivado: float, frente: float) -> bool:
    if not physically_plausible_values(coca, derivado, frente):
        return False
    if coca > 5000 or derivado > 5000 or frente > 5000:
        return False
    tolerance = max(0.35, 0.03 * max(1.0, frente))
    return abs((coca - derivado) - frente) <= tolerance


def relaxed_balance_ok(coca: float, derivado: float, frente: float) -> bool:
    tolerance = max(25.0, 0.50 * max(1.0, frente))
    return abs((coca - derivado) - frente) <= tolerance


def physically_plausible_values(coca: float, derivado: float, frente: float) -> bool:
    return coca >= derivado >= 0 and coca >= frente >= 0


def compact_text(text: str, limit: int = 500) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def choose_best(triples: list[FlowTriple], front_text_value: float | None) -> FlowTriple | None:
    if not triples:
        return None
    return min(triples, key=lambda triple: triple_score(triple, front_text_value))


def confident_triple(triple: FlowTriple, front_text_value: float | None) -> bool:
    if front_text_value is not None and abs(triple.frente_erosion - front_text_value) > 1.0:
        return False
    if triple.qmed_context:
        return relaxed_balance_ok(triple.coca, triple.derivado_css, triple.frente_erosion)
    return valid_flow_triple(triple.coca, triple.derivado_css, triple.frente_erosion)


def fmt_value(value: float | None) -> str:
    if value is None or math.isnan(value):
        return ""
    return f"{value:.2f}".replace(".", ",")


def write_output(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "fecha",
        "caudal_rio_coca_m3s",
        "caudal_derivado_css_m3s",
        "caudal_frente_erosion_m3s",
        "frente_erosion_texto_m3s",
        "balance_error_m3s",
        "status",
        "source",
        "pdf_path",
        "remote_path",
        "ocr_text",
    ]
    with path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def process_job(job: PdfJob, args: argparse.Namespace) -> dict[str, str]:
    doc = fitz.open(job.pdf_path)
    front_text_value = extract_text_front_value(doc)
    candidates = sorted(generate_candidates(job, doc, args.temp_dir), key=lambda item: item.priority)

    triples: list[FlowTriple] = []
    candidate_by_path = {str(candidate.path.resolve()): candidate for candidate in candidates}
    for batch_start in range(0, len(candidates), 8):
        batch = candidates[batch_start : batch_start + 8]
        ocr_results = run_ocr_batch(
            [candidate.path for candidate in batch],
            engine=args.ocr_engine,
            ocr_script=args.ocr_script,
            lang=args.ocr_lang,
        )
        for result in ocr_results:
            result_path = result.get("path")
            if not isinstance(result_path, str):
                continue
            candidate = candidate_by_path.get(str(Path(result_path).resolve()))
            if candidate is None or not result.get("ok"):
                continue
            triple = parse_ocr_result(result, candidate, front_text_value)
            if triple is not None:
                triples.append(triple)
        best_so_far = choose_best(triples, front_text_value)
        if best_so_far is not None and confident_triple(best_so_far, front_text_value):
            break

    best = choose_best(triples, front_text_value)
    if best is None:
        plot_triples = [
            triple
            for candidate in candidates
            if (triple := estimate_plot_triple(candidate, front_text_value)) is not None
        ]
        best = choose_best(plot_triples, front_text_value)

    if best is None:
        status = "missing"
        best = FlowTriple(math.nan, math.nan, math.nan, math.nan, "", "", False)
    else:
        status = "ok"
        text_mismatch = (
            front_text_value is not None
            and abs(best.frente_erosion - front_text_value) > 1.0
        )
        graph_balance_ok = valid_flow_triple(
            best.coca,
            best.derivado_css,
            best.frente_erosion,
        )
        if text_mismatch and not graph_balance_ok:
            status = "review_front_mismatch"

    return {
        "fecha": job.report_date.isoformat(),
        "caudal_rio_coca_m3s": fmt_value(best.coca),
        "caudal_derivado_css_m3s": fmt_value(best.derivado_css),
        "caudal_frente_erosion_m3s": fmt_value(best.frente_erosion),
        "frente_erosion_texto_m3s": fmt_value(front_text_value),
        "balance_error_m3s": "" if math.isnan(best.error) else f"{best.error:.4f}".replace(".", ","),
        "status": status,
        "source": best.source,
        "pdf_path": str(job.pdf_path),
        "remote_path": job.remote_path,
        "ocr_text": best.ocr_text,
    }


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.ocr_engine == "windows":
        if not args.ocr_script.exists():
            print(f"OCR helper not found: {args.ocr_script}", file=sys.stderr)
            return 2
    elif args.ocr_engine == "tesseract":
        if pytesseract is None:
            print("pytesseract no está instalado. Ejecuta: pip install pytesseract", file=sys.stderr)
            return 2

    jobs = read_manifest(args.manifest)
    if args.since:
        since = dt.date.fromisoformat(args.since)
        jobs = [job for job in jobs if job.report_date >= since]
    if args.until:
        until = dt.date.fromisoformat(args.until)
        jobs = [job for job in jobs if job.report_date <= until]
    if args.only_missing:
        done = read_existing_success(args.output)
        jobs = [job for job in jobs if job.pdf_path.resolve() not in done]
    if args.limit:
        jobs = jobs[: args.limit]

    prepare_temp_dir(args.temp_dir)
    rows: list[dict[str, str]] = []
    existing_rows: list[dict[str, str]] = []
    if args.only_missing and args.output.exists():
        with args.output.open(newline="", encoding="utf-8-sig") as file:
            existing_rows = list(csv.DictReader(file))

    print(f"Processing {len(jobs)} PDFs...")
    for index, job in enumerate(jobs, start=1):
        try:
            row = process_job(job, args)
        except Exception as exc:
            row = {
                "fecha": job.report_date.isoformat(),
                "caudal_rio_coca_m3s": "",
                "caudal_derivado_css_m3s": "",
                "caudal_frente_erosion_m3s": "",
                "frente_erosion_texto_m3s": "",
                "balance_error_m3s": "",
                "status": f"error: {exc}",
                "source": "",
                "pdf_path": str(job.pdf_path),
                "remote_path": job.remote_path,
                "ocr_text": "",
            }
        rows.append(row)

        if index == 1 or index % args.progress_every == 0 or index == len(jobs):
            ok_count = sum(1 for item in rows if item["status"] == "ok")
            review_count = sum(1 for item in rows if item["status"].startswith("review"))
            print(
                f"[{index}/{len(jobs)}] ok={ok_count} review={review_count} "
                f"latest={row['fecha']} status={row['status']}"
            )

    final_rows = existing_rows + rows
    final_rows = sorted(final_rows, key=lambda row: (row["fecha"], row["pdf_path"]))
    write_output(args.output, final_rows)
    print(f"Output written: {args.output}")

    if not args.keep_temp:
        shutil.rmtree(args.temp_dir, ignore_errors=True)

    failures = [row for row in rows if row["status"] != "ok"]
    if failures:
        print(f"Completed with {len(failures)} non-ok rows.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
