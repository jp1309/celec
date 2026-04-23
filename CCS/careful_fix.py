#!/usr/bin/env python3
"""
Carefully fix only the dates where:
1. The auto-correction was physically wrong (CSS > normal capacity during non-flood, etc.)
2. We can extract correct values directly from PDF text (Qmed= pattern)

Physical constraints:
- Coca > CSS always
- CSS <= 222 m3/s under normal operation; during major floods may be higher but CSS < Coca always
- Frente = Coca - CSS (balance error should be < 5 m3/s ideally)
- During 2024 Avenida (March-July): Coca can be 400-1200+, CSS still ≤ Coca
"""
import csv
import re
import os
from pathlib import Path
import fitz

CSV_PATH = Path("outputs/celec_daily_flows.csv")

def p(s):
    """Parse Spanish decimal number."""
    if s is None:
        return None
    s = str(s).strip().replace("'", ".").replace(" ", "")
    s = re.sub(r"[oO]", "0", s)
    s = s.replace(",", ".")
    try:
        v = float(s)
        return v if 1 < v < 5000 else None
    except Exception:
        return None


def fmt(v):
    return f"{v:.2f}".replace(".", ",")


def extract_qmed_from_pdf_text(pdf_path):
    """
    Extract Qmed triple from PDF plain text.
    The chart legend has lines like: Qmed=213.8 m3/s  or  QmeF213.8 m3/s
    Returns (coca, css, frente) or None.

    Order in legend: Río Coca (top), Derivado CCS (middle), Frente erosión (bottom).
    """
    path = Path(pdf_path)
    if not path.exists():
        return None, None

    doc = fitz.open(str(path))
    page = doc[0]
    text = page.get_text("text")
    doc.close()

    # Find all Qmed values in order
    # Patterns: Qmed=213.8, QmeF213.8, Q.med=213,8 etc.
    pat = re.compile(
        r"Q(?:med|\.med|mef)[=:\s]*([0-9][0-9,.\s]{1,10})m[3³]",
        re.IGNORECASE
    )
    vals = []
    for m in pat.finditer(text):
        v = p(m.group(1).strip())
        if v is not None:
            vals.append(v)

    return vals, text


def revert_and_fix():
    """Read CSV, identify bad corrections, fix them from PDF text."""

    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames

    # Dates that were auto-corrected (we need to verify each)
    # Format: fecha -> (coca_applied, css_applied, frente_applied)
    auto_corrected = {
        "2024-01-05": (180.0, 19.6, 165.2),    # suspicious: css=19.6 very low, coca changed from 193
        "2024-02-15": (469.8, 244.5, 223.9),    # css jumped, needs verify
        "2024-02-16": (455.8, 325.0, 132.9),    # CSS_high=325
        "2024-02-17": (865.1, 203.9, 665.4),    # css changed to 203.9 from 303.9
        "2024-02-25": (193.3, 7.0, 185.9),      # css=7 very suspicious
        "2024-03-07": (431.3, 410.0, 21.2),     # CSS_high=410
        "2024-03-08": (1159.8, 642.6, 513.5),   # coca changed from 642 to 1159??
        "2024-03-13": (405.9, 103.9, 303.0),    # coca changed from 527.7
        "2024-03-14": (480.0, 235.4, 235.4),    # frente=css?
        "2024-03-17": (215.9, 122.5, 94.9),     # coca changed from 342
        "2024-03-22": (281.1, 63.1, 219.3),     # reordered css/frente
        "2024-03-26": (310.0, 156.9, 156.9),    # frente=css?
        "2024-04-02": (162.6, 91.9, 72.9),      # all three changed
        "2024-04-05": (281.9, 148.1, 136.0),    # coca changed from 374.2
        "2024-04-07": (122.9, 61.3, 61.3),      # all changed; css=frente?
        "2024-04-08": (113.0, 19.8, 91.9),      # coca changed from 336
        "2024-04-26": (53.3, 26.4, 26.4),       # all wrong, huge change
        "2024-05-07": (309.4, 222.1, 87.3),     # css/frente swapped - LIKELY CORRECT
        "2024-05-16": (227.3, 206.7, 20.0),     # frente changed from 31.7 to 20.0
        "2024-05-20": (1456.0, 1233.9, 229.0),  # CSS_high=1233, clearly wrong
        "2024-05-26": (974.0, 477.2, 477.2),    # CSS_high=477, frente=css?
        "2024-06-02": (256.5, 221.3, 35.3),     # coca changed from 277 to 256.5
        "2024-06-24": (345.0, 222.1, 122.9),    # coca changed from 299 to 345
        "2024-06-27": (310.4, 221.7, 88.6),     # coca changed from 362 to 310.4
        "2024-06-30": (271.4, 205.9, 65.5),     # coca changed from 274.4 to 271.4 - minor
        "2024-07-07": (957.0, 811.1, 149.7),    # CSS_high=811, reordered
        "2024-07-12": (320.0, 255.0, 64.0),     # CSS_high=255
        "2024-07-19": (296.1, 222.1, 74.0),     # coca changed 286->296
        "2024-08-07": (227.0, 28.6, 195.7),     # all reordered
        "2024-08-11": (227.7, 207.0, 20.6),     # css changed 169.6->207.0
        "2025-05-07": (317.0, 20.0, 291.0),     # css=20?
    }

    # For each, extract from PDF and determine correct values
    changes = []
    for fecha, (coca_applied, css_applied, frente_applied) in sorted(auto_corrected.items()):
        # Find the row
        row_idx = next((i for i, r in enumerate(rows) if r["fecha"] == fecha), None)
        if row_idx is None:
            print(f"{fecha}: NOT FOUND in CSV")
            continue

        row = rows[row_idx]
        pdf_path = row["pdf_path"]

        qmed_vals, full_text = extract_qmed_from_pdf_text(pdf_path)

        print(f"\n{fecha}:")
        print(f"  Currently applied: coca={coca_applied:.1f} css={css_applied:.1f} frente={frente_applied:.1f}")
        print(f"  PDF Qmed values (in order): {qmed_vals}")

        # Try to identify the correct triple
        # The legend order is: Coca (largest), CSS (middle), Frente (smallest)
        # Unless CSS is being diverted unusually

        if qmed_vals and len(qmed_vals) >= 3:
            # First triple in text
            vals3 = qmed_vals[:3]
            # Sort: largest=coca, medium=css, smallest=frente
            sorted_vals = sorted(vals3, reverse=True)
            coca_pdf = sorted_vals[0]
            css_pdf = sorted_vals[1]
            frente_pdf = sorted_vals[2]
            bal_pdf = abs(coca_pdf - css_pdf - frente_pdf)
            print(f"  PDF triple (sorted): coca={coca_pdf:.1f} css={css_pdf:.1f} frente={frente_pdf:.1f} bal={bal_pdf:.2f}")

            # Accept if balance < 10 and physically plausible
            if bal_pdf < 10 and coca_pdf > css_pdf > 0:
                bal_applied = abs(coca_applied - css_applied - frente_applied)
                print(f"  -> Use PDF triple (bal={bal_pdf:.2f}) vs applied (bal={bal_applied:.2f})")
                changes.append({
                    "idx": row_idx,
                    "fecha": fecha,
                    "coca": coca_pdf,
                    "css": css_pdf,
                    "frente": frente_pdf,
                    "bal": bal_pdf,
                    "reason": "pdf_text_triple",
                })
            else:
                print(f"  -> PDF triple not clean enough, keeping applied values")
        elif qmed_vals and len(qmed_vals) == 2:
            # Two values: usually coca and one other; frente = coca - css
            v1, v2 = sorted(qmed_vals, reverse=True)
            frente_calc = v1 - v2
            if 0 < frente_calc < v2:
                print(f"  PDF 2 values: coca={v1:.1f} css={v2:.1f} frente_calc={frente_calc:.1f}")
                changes.append({
                    "idx": row_idx,
                    "fecha": fecha,
                    "coca": v1,
                    "css": v2,
                    "frente": frente_calc,
                    "bal": 0.0,
                    "reason": "pdf_text_2vals",
                })
            else:
                print(f"  PDF 2 values: {v1:.1f}, {v2:.1f} — cannot determine triple")
        else:
            print(f"  -> Not enough PDF text data")

    print(f"\n{'='*60}")
    print(f"Applying {len(changes)} PDF-confirmed corrections...")

    for c in changes:
        i = c["idx"]
        rows[i]["caudal_rio_coca_m3s"] = fmt(c["coca"])
        rows[i]["caudal_derivado_css_m3s"] = fmt(c["css"])
        rows[i]["caudal_frente_erosion_m3s"] = fmt(c["frente"])
        bal = c["bal"]
        rows[i]["balance_error_m3s"] = fmt(bal)
        rows[i]["status"] = "ok" if bal <= 1.0 else "review"
        rows[i]["source"] = rows[i]["source"].split("|")[0] + "|careful_fix"
        print(f"  {c['fecha']}: coca={c['coca']:.1f} css={c['css']:.1f} frente={c['frente']:.1f} bal={c['bal']:.2f}")

    with open(CSV_PATH, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nDone. {len(changes)} rows updated.")


if __name__ == "__main__":
    revert_and_fix()
