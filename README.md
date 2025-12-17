# CELEC. Hidrología y Producción (CSV mensuales → datasets diarios)

## Estructura esperada del repo (raíz: /celec)

En la raíz del repo deben existir estas carpetas con los CSV mensuales (tú los actualizas):

- `Hidro_mensual/`
- `Produ_mensual/`

Este script NO descarga nada de internet. Solo consolida los CSV locales del repo.

## Qué genera (salida)

El script genera archivos listos para el dashboard dentro de `data/`:

- `data/produccion_diaria_larga.csv`
- `data/hidrologia_diaria_larga.csv`
- `data/meta.json`

### Producción
- Unidad: **MWh**
- Centrales: `molino`, `mazar`, `sopladora`, `msf`, y `csr`
- **CSR se calcula como suma**: Molino + Mazar + Sopladora + MSF.

### Hidrología
- Caudales en **m3/s**
- Cotas en **msnm**
- Variables en columna `kind`: `caudal_m3s` o `cota_msnm`

### Regla para meses parciales (ej. diciembre 2025)
Si un día viene con **todos los valores en 0** (en producción: solo las 4 centrales componentes. En hidrología: todas las columnas numéricas),
se marca como:
- `is_placeholder = 1`
- el valor se convierte a `NA`

Así esos días NO se interpretan como “cero real” en gráficos.

## Cómo correr localmente (Windows)

```bash
cd C:\Users\HP\OneDrive\JpE\Github\celec
python -m venv .venv
.venv\Scripts\activate
pip install pandas
python scripts\build_datasets.py
```

## GitHub Actions
El workflow `.github/workflows/build_datasets.yml` corre diariamente y también manualmente (workflow_dispatch),
y hace commit automático si cambian los datasets.
