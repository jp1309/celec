#!/usr/bin/env python3
"""
Batch review all alert dates (balance > 1 m3/s).
For each date:
1. Extract PDF text and look for Qmed patterns
2. Run OCR on chart crops
3. Try to find a valid triple satisfying Coca - CSS ~ Frente
4. If found triple differs from CSV and has better balance, record as correction
"""
import csv
import re
import os
import sys
import json
import math
import subprocess
import tempfile
from pathlib import Path
import fitz  # PyMuPDF
from PIL import Image

# ── Config ──────────────────────────────────────────────────────────────────
CSV_PATH = Path("outputs/celec_daily_flows.csv")
OCR_SCRIPT = Path("tools/windows_ocr.ps1")
TMP_DIR = Path("tmp/batch_fix")
TMP_DIR.mkdir(parents=True, exist_ok=True)

# ── OCR helper ───────────────────────────────────────────────────────────────
def run_ocr(image_paths):
    """Run Windows OCR on a list of image paths. Returns list of text strings."""
    if not image_paths:
        return []
    list_file = TMP_DIR / "ocr_list.txt"
    list_file.write_text("\n".join(str(p) for p in image_paths), encoding="utf-8")
    result = subprocess.run(
        ["powershell", "-NoProfile", "-File", str(OCR_SCRIPT), str(list_file)],
        capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    texts = []
    try:
        data = json.loads(result.stdout)
        for item in data:
            texts.append(item.get("text", "") if item.get("ok") else "")
    except Exception:
        texts = [""] * len(image_paths)
    return texts


# ── Number parsing ───────────────────────────────────────────────────────────
def parse_num(s):
    """Parse a number with comma or dot decimal separator."""
    s = s.strip().replace("'", ",").replace(" ", "")
    s = re.sub(r"[oO]", "0", s)
    s = s.replace(",", ".")
    try:
        v = float(s)
        return v if 1 < v < 5000 else None
    except Exception:
        return None


# ── Extract Qmed values from OCR text ────────────────────────────────────────
QMED_PAT = re.compile(
    r"Q(?:med|\.med|med=|\.med=|mef)[=:\s]*([0-9][0-9,.'oO\s]{0,8})",
    re.IGNORECASE
)
M3S_PAT = re.compile(
    r"([0-9][0-9,.'oO]{0,8})\s*m[3³](?:/s|s)?",
    re.IGNORECASE
)

def extract_qmed_values(text):
    """Return list of numeric Qmed values found in text, in order."""
    nums = []
    for m in QMED_PAT.finditer(text):
        v = parse_num(m.group(1))
        if v is not None:
            nums.append(v)
    return nums

def extract_m3s_values(text):
    """Return list of m3/s values from text."""
    nums = []
    for m in M3S_PAT.finditer(text):
        v = parse_num(m.group(1))
        if v is not None:
            nums.append(v)
    return nums


# ── Balance check ─────────────────────────────────────────────────────────────
def balance(coca, css, frente):
    return abs(coca - css - frente)


def best_triple_from_values(vals, anchor_coca=None, anchor_frente_txt=None):
    """
    Given a list of candidate values, find the triple (coca, css, frente)
    that best satisfies coca - css ~ frente.
    Optionally anchor coca or frente_txt from PDF text.
    Returns (coca, css, frente, balance_err) or None.
    """
    unique = sorted(set(v for v in vals if v is not None), reverse=True)
    if len(unique) < 2:
        return None

    best = None
    best_err = 999

    # Try all triples from unique values
    for i, coca in enumerate(unique):
        for j, css in enumerate(unique):
            if j == i:
                continue
            frente = coca - css
            if frente < 0:
                continue
            err = min(abs(frente - v) for v in unique) if unique else abs(frente)
            # Check frente is among the candidates (within 5%)
            for fv in unique:
                if abs(fv - frente) / max(frente, 1) < 0.05:
                    real_err = balance(coca, css, fv)
                    if real_err < best_err:
                        best_err = real_err
                        best = (coca, css, fv)

    # If anchor_frente_txt provided, prefer triples that match it
    if anchor_frente_txt is not None and best is not None:
        for i, coca in enumerate(unique):
            for j, css in enumerate(unique):
                if j == i:
                    continue
                frente = anchor_frente_txt
                err = balance(coca, css, frente)
                if err < best_err and coca > css:
                    best_err = err
                    best = (coca, css, frente)

    return best if best is not None else None


# ── PDF processing ────────────────────────────────────────────────────────────
CROPS = {
    "top_right": (0.45, 0.0, 1.0, 0.35),
    "mid_right": (0.45, 0.30, 1.0, 0.60),
    "bot_right": (0.45, 0.55, 1.0, 0.85),
    "bot_wide":  (0.0,  0.60, 1.0, 1.0),
    "full_lower":(0.0,  0.50, 1.0, 1.0),
}

def process_pdf(pdf_path, fecha):
    """Extract Qmed candidates from a PDF using text and OCR."""
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        return None, []

    doc = fitz.open(str(pdf_path))
    page = doc[0]

    # 1. Extract plain text
    text = page.get_text("text")

    # Look for Qmed in text
    qmed_txt = extract_qmed_values(text)
    m3s_txt = extract_m3s_values(text)

    # Look for frente_texto pattern (text often has frente from a separate box)
    frente_txt_pat = re.compile(
        r"frente[^0-9]{0,30}([0-9][0-9,.]{1,8})\s*m[3³]",
        re.IGNORECASE
    )
    frente_txt_match = frente_txt_pat.search(text)
    frente_anchor = parse_num(frente_txt_match.group(1)) if frente_txt_match else None

    # 2. Render crops and OCR
    page_rect = page.rect
    w, h = page_rect.width, page_rect.height

    images = []
    for name, (x0r, y0r, x1r, y1r) in CROPS.items():
        clip = fitz.Rect(x0r*w, y0r*h, x1r*w, y1r*h)
        mat = fitz.Matrix(2.5, 2.5)
        pix = page.get_pixmap(matrix=mat, clip=clip)
        img_path = TMP_DIR / f"{fecha}_{name}.png"
        pix.save(str(img_path))
        images.append(img_path)

    # Also get embedded images
    img_list = page.get_images(full=True)
    for idx, img_info in enumerate(img_list[:4]):
        xref = img_info[0]
        base = doc.extract_image(xref)
        if base and base["width"] > 200:
            img_path = TMP_DIR / f"{fecha}_emb{idx}.png"
            img_path.write_bytes(base["image"])
            images.append(img_path)

    doc.close()

    # Run OCR
    ocr_texts = run_ocr(images)
    combined_ocr = " ".join(ocr_texts)

    # Extract values from OCR
    qmed_ocr = extract_qmed_values(combined_ocr)
    m3s_ocr = extract_m3s_values(combined_ocr)

    # Also from original text
    all_candidates = list(set(qmed_txt + m3s_txt + qmed_ocr + m3s_ocr))

    # Cleanup temp images
    for p in images:
        try:
            p.unlink()
        except Exception:
            pass

    return frente_anchor, all_candidates, text[:500], combined_ocr[:500]


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    # Read CSV
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames

    # Find alert rows
    alert_indices = []
    for i, row in enumerate(rows):
        try:
            bal = float(row["balance_error_m3s"].replace(",", "."))
            if bal > 1.0:
                alert_indices.append(i)
        except Exception:
            pass

    print(f"Processing {len(alert_indices)} alert dates...\n")

    corrections = []

    for idx in alert_indices:
        row = rows[idx]
        fecha = row["fecha"]
        coca_cur = float(row["caudal_rio_coca_m3s"].replace(",", "."))
        css_cur = float(row["caudal_derivado_css_m3s"].replace(",", "."))
        frente_cur = float(row["caudal_frente_erosion_m3s"].replace(",", "."))
        bal_cur = float(row["balance_error_m3s"].replace(",", "."))
        pdf_path = row["pdf_path"]

        print(f"--- {fecha}: coca={coca_cur:.1f} css={css_cur:.1f} frente={frente_cur:.1f} bal={bal_cur:.2f}")

        frente_anchor, candidates, txt_snippet, ocr_snippet = process_pdf(pdf_path, fecha)

        # Filter to plausible range
        candidates = [v for v in candidates if 5 < v < 3000]
        # Remove duplicates, sort descending
        candidates = sorted(set(round(v, 1) for v in candidates), reverse=True)

        print(f"  frente_txt={frente_anchor} candidates={candidates[:12]}")

        # Check if current triple is among candidates
        cur_in_candidates = (
            any(abs(v - coca_cur) < 2 for v in candidates) and
            any(abs(v - css_cur) < 2 for v in candidates) and
            any(abs(v - frente_cur) < 2 for v in candidates)
        )

        # Find best triple
        triple = best_triple_from_values(candidates, anchor_frente_txt=frente_anchor)

        if triple:
            coca_new, css_new, frente_new = triple
            bal_new = balance(coca_new, css_new, frente_new)

            improvement = bal_cur - bal_new
            if improvement > 0.5 and bal_new < bal_cur * 0.8:
                print(f"  CORRECTION: coca={coca_new:.2f} css={css_new:.2f} frente={frente_new:.2f} bal={bal_new:.2f} (was {bal_cur:.2f})")
                corrections.append({
                    "idx": idx,
                    "fecha": fecha,
                    "coca_new": coca_new,
                    "css_new": css_new,
                    "frente_new": frente_new,
                    "bal_new": bal_new,
                    "bal_old": bal_cur,
                    "candidates": candidates[:8],
                    "frente_anchor": frente_anchor,
                })
            else:
                print(f"  no improvement (best triple: {triple}, bal={bal_new:.2f})")
        else:
            print(f"  no valid triple found")

        sys.stdout.flush()

    print(f"\n{'='*60}")
    print(f"Found {len(corrections)} potential corrections")

    if corrections:
        print("\nApplying corrections...")
        for c in corrections:
            i = c["idx"]
            rows[i]["caudal_rio_coca_m3s"] = f"{c['coca_new']:.2f}".replace(".", ",")
            rows[i]["caudal_derivado_css_m3s"] = f"{c['css_new']:.2f}".replace(".", ",")
            rows[i]["caudal_frente_erosion_m3s"] = f"{c['frente_new']:.2f}".replace(".", ",")
            rows[i]["balance_error_m3s"] = f"{c['bal_new']:.4f}".replace(".", ",")
            if c['bal_new'] <= 1.0:
                rows[i]["status"] = "ok"
            rows[i]["source"] = rows[i]["source"] + "|batch_fix"

        # Write back
        with open(CSV_PATH, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

        print(f"CSV updated with {len(corrections)} corrections.")

        print("\nSummary of corrections:")
        for c in corrections:
            print(f"  {c['fecha']}: bal {c['bal_old']:.2f} -> {c['bal_new']:.2f}")

    return corrections


if __name__ == "__main__":
    main()
