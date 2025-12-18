#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build CELEC dashboard datasets from monthly CSVs (Produ_mensual, Hidro_mensual).

Robust behavior:
- Never hard-fails because one monthly file is missing some expected columns.
- If a required column is absent, it is created as NA for that file.
- Production: EnergiaCsr is computed as the sum of Molino+Mazar+Sopladora+MSF when available.
  If those components are missing but EnergiaCsr exists, EnergiaCsr is used as-is.
- Hydrology: supports Caudal* and Cota* columns per plant. Missing columns become NA.

Outputs (written into ./data):
- data/produccion_diaria_larga.csv
- data/hidrologia_diaria_larga.csv
- data/meta.json
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
PROD_DIR = REPO_ROOT / "Produ_mensual"
HIDRO_DIR = REPO_ROOT / "Hidro_mensual"
OUT_DIR = REPO_ROOT / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)


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
    if d.month == 2 and d.day == 29:
        d = d.replace(day=28)
    ref = pd.Timestamp(year=2001, month=d.month, day=d.day)
    return int(ref.dayofyear)


def _mmdd_label(d: pd.Timestamp) -> str:
    months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]
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


# ---- Production ----
PROD_COMPONENTS = {
    "Molino": "EnergiaMol",
    "Mazar": "EnergiaMaz",
    "Sopladora": "EnergiaSop",
    "Minas San Francisco": "EnergiaMsf",
}
PROD_CSR = "EnergiaCsr"


def build_produccion_diaria_larga() -> pd.DataFrame:
    files = sorted(PROD_DIR.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No production CSV files found in {PROD_DIR}")

    rows = []
    for f in files:
        df = _normalize_cols(_read_csv_any_encoding(f))
        df = _parse_date_col(df, "Fecha")

        expected_cols = ["Fecha"] + list(PROD_COMPONENTS.values()) + [PROD_CSR]
        df = _ensure_cols(df, expected_cols)

        for c in list(PROD_COMPONENTS.values()) + [PROD_CSR]:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        comp_cols = list(PROD_COMPONENTS.values())
        comp_sum = df[comp_cols].sum(axis=1, min_count=1)
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
        raise ValueError("Production dataset ended up empty. Check CSV contents.")
    return out


# ---- Hydrology ----
HIDRO_PLANTS = {
    "Molino": ("CaudalMol", "CotaMol"),
    "Mazar": ("CaudalMaz", "CotaMaz"),
    "Sopladora": ("CaudalSop", "CotaSop"),
    "Minas San Francisco": ("CaudalMsf", "CotaMsf"),
    "CSR": ("CaudalCsr", "CotaCsr"),
}


def build_hidrologia_diaria_larga() -> pd.DataFrame:
    files = sorted(HIDRO_DIR.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No hydrology CSV files found in {HIDRO_DIR}")

    rows = []
    for f in files:
        df = _normalize_cols(_read_csv_any_encoding(f))
        df = _parse_date_col(df, "Fecha")

        expected_cols = ["Fecha"]
        for caudal_col, cota_col in HIDRO_PLANTS.values():
            expected_cols += [caudal_col, cota_col]
        df = _ensure_cols(df, expected_cols)

        num_cols = [c for c in expected_cols if c != "Fecha"]
        for c in num_cols:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        df["is_placeholder"] = df.apply(lambda r: _is_placeholder_row(r, num_cols), axis=1)

        for _, r in df.iterrows():
            dt = r["Fecha"]
            year = int(dt.year)
            doy = _doy365(dt)
            mmdd = _mmdd_label(dt)

            for plant, (caudal_col, cota_col) in HIDRO_PLANTS.items():
                vq = r[caudal_col]
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
                vz = r[cota_col]
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
        raise ValueError("Hydrology dataset ended up empty. Check CSV contents.")
    return out


def write_outputs(prod: pd.DataFrame, hidro: pd.DataFrame) -> None:
    prod2 = prod[prod["is_placeholder"] == 0].copy()
    hidro2 = hidro[hidro["is_placeholder"] == 0].copy()

    (OUT_DIR / "produccion_diaria_larga.csv").write_text(prod2.to_csv(index=False), encoding="utf-8")
    (OUT_DIR / "hidrologia_diaria_larga.csv").write_text(hidro2.to_csv(index=False), encoding="utf-8")

    meta = {
        "generated_at_utc": pd.Timestamp.utcnow().isoformat(),
        "produccion": {
            "rows": int(len(prod2)),
            "years": sorted(prod2["year"].unique().tolist()),
            "series": sorted(prod2["series"].unique().tolist()),
            "metrics": sorted(prod2["metric"].unique().tolist()),
        },
        "hidrologia": {
            "rows": int(len(hidro2)),
            "years": sorted(hidro2["year"].unique().tolist()),
            "series": sorted(hidro2["series"].unique().tolist()),
            "metrics": sorted(hidro2["metric"].unique().tolist()),
        },
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    prod = build_produccion_diaria_larga()
    hidro = build_hidrologia_diaria_larga()
    write_outputs(prod, hidro)
    print("OK. Wrote datasets to ./data")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
