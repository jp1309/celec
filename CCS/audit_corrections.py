#!/usr/bin/env python3
"""
For each auto-corrected date, read the PDF text to get ground truth Qmed values.
Output a report + apply only PDF-confirmed corrections.
"""
import csv
import re
from pathlib import Path
import fitz

CSV_PATH = Path("outputs/celec_daily_flows.csv")

def p(s):
    s = str(s).strip().replace("'", ".").replace(" ", "")
    s = re.sub(r"[oO](?=[0-9])|(?<=[0-9])[oO]", "0", s)
    s = s.replace(",", ".")
    try:
        v = float(s)
        return v if 1 < v < 5000 else None
    except:
        return None

def fmt(v):
    return f"{v:.2f}".replace(".", ",")

def get_pdf_qmeds(pdf_path):
    """Extract all Qmed= values from PDF text in order of appearance."""
    path = Path(pdf_path)
    if not path.exists():
        return [], ""
    doc = fitz.open(str(path))
    text = doc[0].get_text("text")
    doc.close()

    pat = re.compile(
        r"Q(?:med|\.med|mef)[=:\s]+([0-9][0-9,.\s]{1,10})m[3³]",
        re.IGNORECASE
    )
    vals = []
    for m in pat.finditer(text):
        v = p(m.group(1).strip())
        if v is not None and v not in vals:
            vals.append(v)
    return vals, text[:800]

def main():
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames

    # All dates that have |batch_fix in source (auto-corrected by batch_fix_alerts.py)
    batch_fixed = []
    for i, row in enumerate(rows):
        if "|batch_fix" in row["source"]:
            batch_fixed.append(i)

    print(f"Found {len(batch_fixed)} batch-fixed rows\n")

    corrections = []  # rows to update with PDF-confirmed values
    reverts = []      # rows that look wrong and need manual review

    for i in batch_fixed:
        row = rows[i]
        fecha = row["fecha"]
        coca = float(row["caudal_rio_coca_m3s"].replace(",","."))
        css  = float(row["caudal_derivado_css_m3s"].replace(",","."))
        frente = float(row["caudal_frente_erosion_m3s"].replace(",","."))
        bal  = float(row["balance_error_m3s"].replace(",","."))
        pdf  = row["pdf_path"]

        qmeds, snippet = get_pdf_qmeds(pdf)
        # unique in order
        seen = set(); uqmeds = []
        for v in qmeds:
            if v not in seen:
                seen.add(v); uqmeds.append(v)

        # Find best triple from PDF qmeds where coca>css>frente>0 and balance<5
        best = None
        best_bal = 999
        from itertools import permutations
        for combo in permutations(uqmeds[:6], 3):
            c, s, f = combo
            if c > s > 0 and f > 0:
                b = abs(c - s - f)
                if b < best_bal:
                    best_bal = b
                    best = (c, s, f, b)

        # Check if current applied values are among the PDF qmeds
        coca_in_pdf = any(abs(v - coca) < 2 for v in uqmeds)
        css_in_pdf  = any(abs(v - css) < 2 for v in uqmeds)
        frente_in_pdf = any(abs(v - frente) < 2 for v in uqmeds)
        all_in_pdf = coca_in_pdf and css_in_pdf and frente_in_pdf

        print(f"{fecha}: CSV=({coca:.1f},{css:.1f},{frente:.1f}) bal={bal:.2f}")
        print(f"  PDF qmeds: {uqmeds[:8]}")

        if best and best_bal < 2 and best[0] > best[1] > 0:
            c_pdf, s_pdf, f_pdf, b_pdf = best
            # If PDF triple differs from CSV (by more than 2), use PDF
            if abs(c_pdf - coca) > 2 or abs(s_pdf - css) > 2 or abs(f_pdf - frente) > 2:
                print(f"  -> PDF triple: ({c_pdf:.1f},{s_pdf:.1f},{f_pdf:.1f}) bal={b_pdf:.2f}  [APPLY]")
                corrections.append({
                    "idx": i, "fecha": fecha,
                    "coca": c_pdf, "css": s_pdf, "frente": f_pdf, "bal": b_pdf
                })
            else:
                print(f"  -> CSV matches PDF triple OK")
        elif all_in_pdf and bal < 5:
            print(f"  -> All values in PDF, balance acceptable")
        else:
            print(f"  -> NEEDS MANUAL REVIEW (best_pdf={best})")
            reverts.append({"idx": i, "fecha": fecha, "coca": coca, "css": css,
                           "frente": frente, "bal": bal, "pdf_qmeds": uqmeds})

    print(f"\n{'='*60}")
    print(f"PDF-confirmed corrections: {len(corrections)}")
    print(f"Needs manual review: {len(reverts)}")

    print("\nApplying PDF-confirmed corrections...")
    for c in corrections:
        i = c["idx"]
        rows[i]["caudal_rio_coca_m3s"] = fmt(c["coca"])
        rows[i]["caudal_derivado_css_m3s"] = fmt(c["css"])
        rows[i]["caudal_frente_erosion_m3s"] = fmt(c["frente"])
        rows[i]["balance_error_m3s"] = fmt(c["bal"])
        rows[i]["status"] = "ok" if c["bal"] <= 1.0 else "review"
        rows[i]["source"] = rows[i]["source"].replace("|batch_fix", "") + "|pdf_confirmed"

    with open(CSV_PATH, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print("\nManual review list (needs human/visual verification):")
    for r in reverts:
        print(f"  {r['fecha']}: ({r['coca']:.1f},{r['css']:.1f},{r['frente']:.1f}) bal={r['bal']:.2f}  pdf={r['pdf_qmeds'][:6]}")

if __name__ == "__main__":
    main()
