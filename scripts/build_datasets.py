#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CELEC: build datasets and place them where GitHub Pages can serve them.

Key fix vs previous version:
- Writes outputs to BOTH:
    - ./data (repo root)           [useful for local inspection]
    - ./public/data (served by Pages)

Robust to missing columns: creates them as NA.
Treats rows with all-zero values as placeholders (not yet published by source) and excludes them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Dict, Tuple

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
PROD_DIR = REPO_ROOT / "Produ_mensual"
HIDRO_DIR = REPO_ROOT / "Hidro_mensual"
CCS_FLOWS_CSV = REPO_ROOT / "CCS" / "outputs" / "celec_daily_flows.csv"

OUT_DIR1 = REPO_ROOT / "data"
OUT_DIR2 = REPO_ROOT / "public" / "data"
OUT_DIR1.mkdir(parents=True, exist_ok=True)
OUT_DIR2.mkdir(parents=True, exist_ok=True)


def _read_csv_any_encoding(path: Path) -> pd.DataFrame:
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return pd.read_csv(path, encoding=enc)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, encoding="latin-1")


def _normalize_cols(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _ensure_cols(df: pd.DataFrame, cols: List[str]) -> pd.DataFrame:
    df = df.copy()
    for c in cols:
        if c not in df.columns:
            df[c] = pd.NA
    return df


def _parse_date_col(df: pd.DataFrame, date_col: str = "Fecha") -> pd.DataFrame:
    df = df.copy()
    if date_col not in df.columns:
        for cand in ("FECHA", "fecha", "Date", "DATE"):
            if cand in df.columns:
                df.rename(columns={cand: date_col}, inplace=True)
                break
    if date_col not in df.columns:
        raise ValueError(f"Missing date column '{date_col}' in a monthly file.")
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce", dayfirst=True)
    df = df.dropna(subset=[date_col])
    return df


def _doy365(d: pd.Timestamp) -> int:
    # Normalize to a 365-day calendar by mapping Feb 29 -> Feb 28
    if d.month == 2 and d.day == 29:
        d = d.replace(day=28)
    ref = pd.Timestamp(year=2001, month=d.month, day=d.day)
    return int(ref.dayofyear)


def _mmdd_label(d: pd.Timestamp) -> str:
    months = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"]
    return f"{int(d.day):02d}-{months[int(d.month)-1]}"


def _is_placeholder_row(row: pd.Series, value_cols: List[str]) -> int:
    vals = []
    for c in value_cols:
        v = row.get(c, pd.NA)
        if pd.isna(v):
            return 0
        try:
            vals.append(float(v))
        except Exception:
            return 0
    if not vals:
        return 0
    return int(all(v == 0.0 for v in vals))


# ---------------- Production ----------------
PROD_COMPONENTS: Dict[str, str] = {
    "Molino": "EnergiaMol",
    "Mazar": "EnergiaMaz",
    "Sopladora": "EnergiaSop",
    "Minas San Francisco": "EnergiaMsf",
}
PROD_CSR = "EnergiaCsr"  # should equal Mol+Maz+Sop+MSF when components are present


def build_produccion_diaria_larga() -> pd.DataFrame:
    files = sorted(PROD_DIR.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No production CSV files found in {PROD_DIR}")

    rows = []
    for f in files:
        df = _normalize_cols(_read_csv_any_encoding(f))
        df = _parse_date_col(df, "Fecha")

        expected = ["Fecha"] + list(PROD_COMPONENTS.values()) + [PROD_CSR]
        df = _ensure_cols(df, expected)

        for c in list(PROD_COMPONENTS.values()) + [PROD_CSR]:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        comp_cols = list(PROD_COMPONENTS.values())
        comp_sum = df[comp_cols].sum(axis=1, min_count=1)
        # If components exist, recompute CSR. Otherwise keep EnergiaCsr if present.
        df[PROD_CSR] = comp_sum.where(~comp_sum.isna(), df[PROD_CSR])

        value_cols = comp_cols + [PROD_CSR]
        df["is_placeholder"] = df.apply(lambda r: _is_placeholder_row(r, value_cols), axis=1)

        for _, r in df.iterrows():
            dt = r["Fecha"]
            year = int(dt.year)
            doy = _doy365(dt)
            mmdd = _mmdd_label(dt)

            for plant, col in PROD_COMPONENTS.items():
                val = r[col]
                if pd.isna(val):
                    continue
                rows.append({
                    "date": dt.date().isoformat(),
                    "year": year,
                    "doy365": doy,
                    "mmdd": mmdd,
                    "series": plant,
                    "metric": "Energía (MWh)",
                    "value": float(val),
                    "is_placeholder": int(r["is_placeholder"]),
                })

            if not pd.isna(r[PROD_CSR]):
                rows.append({
                    "date": dt.date().isoformat(),
                    "year": year,
                    "doy365": doy,
                    "mmdd": mmdd,
                    "series": "CSR (Mol+Maz+Sop+MSF)",
                    "metric": "Energía (MWh)",
                    "value": float(r[PROD_CSR]),
                    "is_placeholder": int(r["is_placeholder"]),
                })

    out = pd.DataFrame(rows)
    if out.empty:
        raise ValueError("Production dataset ended up empty.")
    
    # Deduplicate and sort
    out = out.drop_duplicates(subset=["date", "series", "metric"], keep="last")
    out = out.sort_values(["date", "series"])
    
    return out


# ---------------- Hydrology ----------------
HIDRO_PLANTS: Dict[str, Tuple[str, str | None]] = {
    "Cuenca del Rio Paute": ("CaudalCuencaPaute", None),
    "Molino": ("CaudalMol", "CotaMol"),
    "Mazar": ("CaudalMaz", "CotaMaz"),
    "Sopladora": ("CaudalSop", "CotaSop"),
    "Minas San Francisco": ("CaudalMsf", "CotaMsf"),
}


def build_hidrologia_diaria_larga() -> pd.DataFrame:
    files = sorted(HIDRO_DIR.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No hydrology CSV files found in {HIDRO_DIR}")

    rows = []
    for f in files:
        df = _normalize_cols(_read_csv_any_encoding(f))
        df = _parse_date_col(df, "Fecha")

        expected = ["Fecha"]
        for caudal_col, cota_col in HIDRO_PLANTS.values():
            expected.append(caudal_col)
            if cota_col:
                expected.append(cota_col)
        df = _ensure_cols(df, expected)

        num_cols = [c for c in expected if c != "Fecha"]
        for c in num_cols:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        df["is_placeholder"] = df.apply(lambda r: _is_placeholder_row(r, num_cols), axis=1)

        for _, r in df.iterrows():
            dt = r["Fecha"]
            year = int(dt.year)
            doy = _doy365(dt)
            mmdd = _mmdd_label(dt)

            for plant, (caudal_col, cota_col) in HIDRO_PLANTS.items():
                vq = r.get(caudal_col, pd.NA)
                if not pd.isna(vq):
                    rows.append({
                        "date": dt.date().isoformat(),
                        "year": year,
                        "doy365": doy,
                        "mmdd": mmdd,
                        "series": plant,
                        "metric": "Caudal (m³/s)",
                        "value": float(vq),
                        "is_placeholder": int(r["is_placeholder"]),
                    })
                
                if cota_col:
                    vz = r.get(cota_col, pd.NA)
                    if not pd.isna(vz):
                        rows.append({
                            "date": dt.date().isoformat(),
                            "year": year,
                            "doy365": doy,
                            "mmdd": mmdd,
                            "series": plant,
                            "metric": "Cota (msnm)",
                            "value": float(vz),
                            "is_placeholder": int(r["is_placeholder"]),
                        })

    out = pd.DataFrame(rows)
    if out.empty:
        raise ValueError("Hydrology dataset ended up empty.")
    
    # Deduplicate and sort
    out = out.drop_duplicates(subset=["date", "series", "metric"], keep="last")
    out = out.sort_values(["date", "series", "metric"])

    return out


def _coma_to_float(v) -> float | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip()
    if not s:
        return None
    s = s.replace(".", "").replace(",", ".") if s.count(",") == 1 and s.count(".") <= 1 else s.replace(",", ".")
    try:
        x = float(s)
        return x if pd.notna(x) else None
    except ValueError:
        return None


def build_ccs_caudales() -> pd.DataFrame:
    if not CCS_FLOWS_CSV.exists():
        return pd.DataFrame(columns=["date", "coca", "css", "frente", "balance", "status"])

    df = _read_csv_any_encoding(CCS_FLOWS_CSV)
    df = _normalize_cols(df)

    out_rows = []
    for _, r in df.iterrows():
        date = str(r.get("fecha", "")).strip()
        if not date:
            continue
        coca = _coma_to_float(r.get("caudal_rio_coca_m3s"))
        css = _coma_to_float(r.get("caudal_derivado_css_m3s"))
        frente = _coma_to_float(r.get("caudal_frente_erosion_m3s"))
        balance = _coma_to_float(r.get("balance_error_m3s"))
        status = str(r.get("status", "")).strip()
        if coca is None and css is None and frente is None:
            continue
        out_rows.append({
            "date": date,
            "coca": coca,
            "css": css,
            "frente": frente,
            "balance": balance,
            "status": status,
        })

    out = pd.DataFrame(out_rows)
    if out.empty:
        return out
    out = out.drop_duplicates(subset=["date"], keep="last").sort_values("date")
    return out


def _write_csv_both(name: str, df: pd.DataFrame) -> None:
    csv_text = df.to_csv(index=False)
    (OUT_DIR1 / name).write_text(csv_text, encoding="utf-8")
    (OUT_DIR2 / name).write_text(csv_text, encoding="utf-8")


def _write_json_both(name: str, obj: dict) -> None:
    txt = json.dumps(obj, ensure_ascii=False, indent=2)
    (OUT_DIR1 / name).write_text(txt, encoding="utf-8")
    (OUT_DIR2 / name).write_text(txt, encoding="utf-8")


def main() -> int:
    prod = build_produccion_diaria_larga()
    hidro = build_hidrologia_diaria_larga()

    # Drop placeholder rows (all-zero rows) from published datasets
    prod_pub = prod[prod["is_placeholder"] == 0].copy()
    hidro_pub = hidro[hidro["is_placeholder"] == 0].copy()

    _write_csv_both("produccion_diaria_larga.csv", prod_pub)
    _write_csv_both("hidrologia_diaria_larga.csv", hidro_pub)

    ccs = build_ccs_caudales()
    _write_csv_both("ccs_caudales_diarios.csv", ccs)

    meta = {
        "generated_at_utc": pd.Timestamp.utcnow().isoformat(),
        "produccion": {
            "rows": int(len(prod_pub)),
            "years": sorted(prod_pub["year"].unique().tolist()),
            "series": sorted(prod_pub["series"].unique().tolist()),
            "metrics": sorted(prod_pub["metric"].unique().tolist()),
        },
        "hidrologia": {
            "rows": int(len(hidro_pub)),
            "years": sorted(hidro_pub["year"].unique().tolist()),
            "series": sorted(hidro_pub["series"].unique().tolist()),
            "metrics": sorted(hidro_pub["metric"].unique().tolist()),
        },
        "ccs": _ccs_meta(ccs),
    }
    _write_json_both("meta.json", meta)

    print("OK. Wrote datasets to ./data and ./public/data")
    return 0


def _ccs_meta(ccs: pd.DataFrame) -> dict:
    if ccs.empty:
        return {"rows": 0, "fecha_min": None, "fecha_max": None,
                "ultimo_coca": None, "ultimo_css": None, "ultimo_frente": None}
    last = ccs.iloc[-1]
    return {
        "rows": int(len(ccs)),
        "fecha_min": str(ccs["date"].min()),
        "fecha_max": str(ccs["date"].max()),
        "ultimo_coca": None if pd.isna(last["coca"]) else float(last["coca"]),
        "ultimo_css": None if pd.isna(last["css"]) else float(last["css"]),
        "ultimo_frente": None if pd.isna(last["frente"]) else float(last["frente"]),
        "years": sorted({int(d[:4]) for d in ccs["date"] if isinstance(d, str) and len(d) >= 4}),
    }


if __name__ == "__main__":
    raise SystemExit(main())
