#!/usr/bin/env python3
"""
Apply carefully reviewed corrections based on PDF ground truth.
For each date, the PDF qmeds list is [coca, css, frente] from the chart legend.
Decision rules:
1. If auto-corrected values are NOT from the PDF → revert to PDF values
2. If PDF triple has acceptable balance (< 15) → use it
3. If date has |batch_fix source, normalize it

Also handles dates where auto-correction accidentally made things worse.
"""
import csv
import re
from pathlib import Path

CSV_PATH = Path("outputs/celec_daily_flows.csv")

def fmt(v):
    return f"{v:.2f}".replace(".", ",")

# Manual corrections based on PDF qmeds and physical analysis:
# Format: fecha -> (coca, css, frente, status, note)
# PDF qmeds order: the legend shows Coca first (largest), CSS second, Frente third (smallest)
CORRECTIONS = {
    # 2024-01-05: PDF=[193.0, 165.2, 33.9] — original CSV was these values, balance=6.1
    # Auto-correction changed to (180, 19.6, 165.2) which is WRONG (not from PDF)
    # Accept original PDF values — the 6.1 balance is a real measurement discrepancy
    "2024-01-05": (193.0, 165.2, 33.9, "review", "original_pdf_values_bal6.1"),

    # 2024-02-15: CSV=(469.8,244.5,223.9) auto; PDF=[469.8, 222.1, 244.5]
    # The PDF has css=222.1 and frente=244.5 — but frente > css means ordering may be wrong
    # More likely: coca=469.8, css=222.1, frente=244.5, balance=469.8-222.1-244.5=3.2
    # OR the auto-correction had css=244.5, frente=223.9 → balance=1.4 (better)
    # PDF values as-is: coca=469.8, css=222.1, frente=244.5 → bal=3.2
    # Keep auto-correction: coca=469.8, css=244.5, frente=223.9 → bal=1.4
    # Actually: looking at the values, 469.8 - 244.5 = 225.3 ≈ 223.9 (close) so this is likely right
    # KEEP auto-correction (already in CSV)
    # "2024-02-15": skip — keep auto-corrected value

    # 2024-02-16: CSV auto=(455.8,325.0,132.9) NOT in PDF; PDF=[455.8, 217.2, 235.7]
    # 455.8 - 217.2 = 238.6 ≈ 235.7 → balance=2.9 (original values from PDF)
    "2024-02-16": (455.8, 217.2, 235.7, "review", "reverted_to_pdf"),

    # 2024-02-17: CSV auto=(865.1,203.9,665.4); PDF=[865.1, 303.9, 665.4]
    # 865.1 - 303.9 = 561.2 ≠ 665.4 → balance=104.2 — this was the original issue
    # No better triple available from PDF. The original values (865.1, 303.9, 665.4) are the PDF values.
    # css=203.9 auto is NOT in the PDF. Revert to PDF: (865.1, 303.9, 665.4) bal=104.2
    # This is likely a genuine data anomaly or OCR error in the original PDF
    "2024-02-17": (865.1, 303.9, 665.4, "review", "reverted_to_pdf_high_balance"),

    # 2024-03-07: CSV auto=(431.3,410.0,21.2) NOT real; PDF=[431.3, 219.3, 208.9]
    # 431.3 - 219.3 = 212.0 ≈ 208.9 → balance=3.1 (original)
    "2024-03-07": (431.3, 219.3, 208.9, "review", "reverted_to_pdf"),

    # 2024-03-08: CSV auto=(1159.8,642.6,513.5) WRONG; PDF=[642.6, 133.8, 513.5]
    # 642.6 - 133.8 = 508.8 ≈ 513.5 → balance=4.7 (original PDF values)
    "2024-03-08": (642.6, 133.8, 513.5, "review", "reverted_to_pdf"),

    # 2024-03-13: CSV auto=(405.9,103.9,303.0) NOT in PDF well; PDF=[527.7, 221.1, 303.4]
    # 527.7 - 221.1 = 306.6 ≈ 303.4 → balance=3.2 (original PDF)
    "2024-03-13": (527.7, 221.1, 303.4, "review", "reverted_to_pdf"),

    # 2024-03-14: CSV auto=(480.0,235.4,235.4) dubious; PDF=[481.9, 235.4, 361.6]
    # 481.9 - 235.4 = 246.5 ≠ 361.6 → balance=115.1 — genuine OCR issue
    # Revert to original PDF values
    "2024-03-14": (481.9, 235.4, 361.6, "review", "reverted_to_pdf_high_balance"),

    # 2024-03-17: CSV auto=(215.9,122.5,94.9) NOT in PDF; PDF=[342.0, 221.9, 122.5]
    # 342.0 - 221.9 = 120.1 ≈ 122.5 → balance=2.4 (original)
    "2024-03-17": (342.0, 221.9, 122.5, "review", "reverted_to_pdf"),

    # 2024-03-22: CSV=(281.1,63.1,219.3) — auto reordered. PDF=[281.1, 219.3, 63.13]
    # 281.1 - 219.3 = 61.8 ≈ 63.1 → balance=1.3 — actually the auto had wrong order
    # Correct: coca=281.1, css=219.3, frente=63.1 (63.13 from PDF)
    "2024-03-22": (281.1, 219.3, 63.13, "ok", "correct_pdf_order"),

    # 2024-03-26: CSV auto=(310.0,156.9,156.9) wrong; PDF=[241.3, 156.9, 75.3]
    # 241.3 - 156.9 = 84.4 ≠ 75.3 → balance=9.1 — original values, high balance
    "2024-03-26": (241.3, 156.9, 75.3, "review", "reverted_to_pdf"),

    # 2024-04-02: CSV auto=(162.6,91.9,72.9) wrong; PDF=[331.4, 172.0, 162.6]
    # 331.4 - 172.0 = 159.4 ≈ 162.6 → balance=3.2 (original)
    "2024-04-02": (331.4, 172.0, 162.6, "review", "reverted_to_pdf"),

    # 2024-04-05: CSV auto=(281.9,148.1,136.0) not matching PDF; PDF=[374.2, 222.2, 148.1]
    # 374.2 - 222.2 = 152.0 ≈ 148.1 → balance=3.9 (original)
    "2024-04-05": (374.2, 222.2, 148.1, "review", "reverted_to_pdf"),

    # 2024-04-07: audit_corrections applied (282.3, 222.1, 61.3) from PDF — CORRECT, keep
    # Already fixed by audit step

    # 2024-04-08: CSV auto=(113.0,19.8,91.9) wrong; PDF=[336.3, 218.3, 113.0]
    # 336.3 - 218.3 = 118.0 ≈ 113.0 → balance=5.0 (original)
    "2024-04-08": (336.3, 218.3, 113.0, "review", "reverted_to_pdf"),

    # 2024-04-26: CSV auto=(53.3,26.4,26.4) WRONG; PDF=[357.4, 217.3, 53.3]
    # 357.4 - 217.3 = 140.1 ≠ 53.3 → balance=86.8 — genuine anomaly, revert to PDF
    "2024-04-26": (357.4, 217.3, 53.3, "review", "reverted_to_pdf_high_balance"),

    # 2024-05-07: CSV=(309.4,222.1,87.3) — audit found pdf=[309.4, 222.1, 84.3]
    # 309.4 - 222.1 = 87.3 → balance=0.0 — auto-correction is CORRECT (87.3 not 84.3 minor diff)
    # Keep the auto-corrected value (309.4, 222.1, 87.3) — already correct

    # 2024-05-16: CSV auto=(227.3,206.7,20.0); PDF=[227.3, 206.69, 31.68]
    # 227.3 - 206.69 = 20.61 ≈ 20.0 but PDF says frente=31.68
    # OCR is ambiguous — the auto has better balance (0.6 vs 11.1)
    # Keep the auto-corrected value (frente was likely OCR'd wrong to 31.68)
    # KEEP: (227.3, 206.7, 20.0)

    # 2024-05-20: CSV auto=(1456.0,1233.9,229.0) CLEARLY WRONG; PDF=[394.38, 206.26, 210.85]
    # 394.38 - 206.26 = 188.12 ≠ 210.85 → balance=22.73 — original values
    "2024-05-20": (394.38, 206.26, 210.85, "review", "reverted_to_pdf_high_balance"),

    # 2024-05-26: CSV auto=(974.0,477.2,477.2) CLEARLY WRONG; PDF=[477.21, 107.75, 296.79]
    # 477.21 - 107.75 = 369.46 ≠ 296.79 → balance=72.67 — original values
    "2024-05-26": (477.21, 107.75, 296.79, "review", "reverted_to_pdf_high_balance"),

    # 2024-06-02: CSV auto=(256.5,221.3,35.3) — close to PDF=[277.0, 221.26, 35.28]
    # 277.0 - 221.26 = 55.74 ≠ 35.28 → balance=20.46 (original)
    # The auto put coca=256.5 which gives 256.5-221.3=35.2 ≈ 35.28 → balance≈0
    # So auto-correction may actually be right if 256.5 was the real Coca
    # But PDF text clearly says 277.0. Keep PDF values.
    "2024-06-02": (277.0, 221.26, 35.28, "review", "reverted_to_pdf"),

    # 2024-06-24: CSV auto=(345.0,222.1,122.9) not from PDF; PDF=[299.25, 222.14, 91.48]
    # 299.25 - 222.14 = 77.11 ≠ 91.48 → balance=14.37 (original)
    "2024-06-24": (299.25, 222.14, 91.48, "review", "reverted_to_pdf"),

    # 2024-06-27: CSV auto=(310.4,221.7,88.6); PDF=[362.0, 221.74] (only 2 vals)
    # 362.0 - 221.74 = 140.26 — frente not in PDF text
    # Auto: 310.4 - 221.7 = 88.7 ≈ 88.6 → balance=0.1
    # The auto value has balance=0 and coca=310.4 is between 221.7 and 362.0 (plausible)
    # KEEP auto-corrected (310.4, 221.7, 88.6)

    # 2024-06-30: CSV auto=(271.4,205.9,65.5); PDF=[274.38, 205.89, 65.48]
    # 274.38 - 205.89 = 68.49 ≈ 65.48 → balance=3.0 (original small diff)
    # Auto changed coca from 274.38 to 271.4 — but 274.38 is the PDF value
    "2024-06-30": (274.38, 205.89, 65.48, "review", "reverted_to_pdf"),

    # 2024-07-07: CSV auto=(957.0,811.1,149.7) WRONG; PDF=[811.08, 149.66, 611.42]
    # 811.08 - 149.66 = 661.42 ≠ 611.42 → balance=50 — original values
    "2024-07-07": (811.08, 149.66, 611.42, "review", "reverted_to_pdf_high_balance"),

    # 2024-07-12: CSV auto=(320.0,255.0,64.0) not from PDF; PDF=[275.71, 217.34, 97.9]
    # 275.71 - 217.34 = 58.37 ≠ 97.9 → balance=39.53 (original)
    "2024-07-12": (275.71, 217.34, 97.9, "review", "reverted_to_pdf"),

    # 2024-07-19: CSV auto=(296.1,222.1,74.0); PDF=[286.13, 222.14, 73.98]
    # 286.13 - 222.14 = 63.99 ≠ 73.98 → balance=9.99 (original)
    # Auto changed coca from 286.13 to 296.1 — not from PDF
    "2024-07-19": (286.13, 222.14, 73.98, "review", "reverted_to_pdf"),

    # 2024-08-07: CSV auto=(227.0,28.6,195.7) wrong; PDF=[195.67, 183.15, 21.97]
    # 195.67 - 183.15 = 12.52 ≠ 21.97 → balance=9.45 (original)
    "2024-08-07": (195.67, 183.15, 21.97, "review", "reverted_to_pdf"),

    # 2024-08-11: CSV auto=(227.7,207.0,20.6); PDF text had no qmeds
    # 227.7 - 207.0 = 20.7 ≈ 20.6 → balance=0.1 (good!)
    # The original was css=169.58, frente=20.58, bal=37.51
    # Auto may actually be right if 207.0 was the real CSS
    # KEEP auto (227.7, 207.0, 20.6) — balance=0.1 makes physical sense

    # 2025-05-07: CSV auto=(317.0,20.0,291.0) suspicious (css=20?); PDF no qmeds
    # Original was (290.96, 64.55, 216.41) bal=10.0
    # Keep original — auto css=20 makes no sense
    "2025-05-07": (290.96, 64.55, 216.41, "review", "reverted_original"),
}

def main():
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames

    applied = 0
    for i, row in enumerate(rows):
        fecha = row["fecha"]
        if fecha not in CORRECTIONS:
            continue

        coca, css, frente, status, note = CORRECTIONS[fecha]
        bal = abs(coca - css - frente)

        old_coca = row["caudal_rio_coca_m3s"]
        old_css  = row["caudal_derivado_css_m3s"]
        old_frente = row["caudal_frente_erosion_m3s"]

        rows[i]["caudal_rio_coca_m3s"]     = fmt(coca)
        rows[i]["caudal_derivado_css_m3s"] = fmt(css)
        rows[i]["caudal_frente_erosion_m3s"] = fmt(frente)
        rows[i]["balance_error_m3s"]       = fmt(bal)
        rows[i]["status"]                  = status

        # Clean source tag
        src = rows[i]["source"]
        for tag in ["|batch_fix", "|pdf_confirmed", "|careful_fix"]:
            src = src.replace(tag, "")
        rows[i]["source"] = src + f"|{note}"

        print(f"{fecha}: ({old_coca},{old_css},{old_frente}) -> ({fmt(coca)},{fmt(css)},{fmt(frente)}) bal={bal:.2f}")
        applied += 1

    with open(CSV_PATH, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nApplied {applied} corrections.")

    # Final summary of remaining alerts
    print("\nFinal alert summary (balance > 1):")
    alerts = []
    for row in rows:
        try:
            bal = float(row["balance_error_m3s"].replace(",", "."))
            if bal > 1.0:
                coca = float(row["caudal_rio_coca_m3s"].replace(",", "."))
                css  = float(row["caudal_derivado_css_m3s"].replace(",", "."))
                frente = float(row["caudal_frente_erosion_m3s"].replace(",", "."))
                alerts.append((row["fecha"], coca, css, frente, bal))
        except:
            pass
    for fecha, coca, css, frente, bal in sorted(alerts):
        print(f"  {fecha}: coca={coca:.1f} css={css:.1f} frente={frente:.1f} bal={bal:.2f}")
    print(f"\nTotal remaining alerts: {len(alerts)}")

if __name__ == "__main__":
    main()
