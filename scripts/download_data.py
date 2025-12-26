import requests
import pandas as pd
import json
from datetime import datetime, timedelta
from pathlib import Path
import os
import urllib3

# Deshabilitar advertencias de certificados inseguros ya que usamos verify=False
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Configuración de la API
BASE_URL = "https://generacioncsr.celec.gob.ec:8443/ords/csr"
TIMEOUT = 30

# Mapeo de variables
PROD_ENDPOINTS = {
    "EnergiaMaz": "sardommaz/mazEnerDia",
    "EnergiaMol": "sardommol/molEnerDia",
    "EnergiaSop": "sardomsop/sopEnerDia",
    "EnergiaMsf": "sardommsf/msfEnerDia",
    "EnergiaCsr": "sardomcsr/csrEnerDia"
}

HIDRO_MRIDS = {
    "CaudalCuencaPaute": 30538,
    "CaudalMol": 24811,
    "CotaMol": 24019,
    "CaudalMaz": 30538,
    "CotaMaz": 30031,
    "CaudalSop": 90537,
    "CotaSop": 90919,
    "CaudalMsf": 650538,
    "CotaMsf": 650919
}

SPANISH_MONTHS = {
    1: "enero", 2: "febrero", 3: "marzo", 4: "abril",
    5: "mayo", 6: "junio", 7: "julio", 8: "agosto",
    9: "septiembre", 10: "octubre", 11: "noviembre", 12: "diciembre"
}

def get_monthly_filename(date, category):
    """Retorna el nombre del archivo según la convención: Categoría_CSR_mes-año.csv"""
    month_name = SPANISH_MONTHS[date.month]
    year = date.year
    prefix = "Producción" if category == "prod" else "Hidrología"
    return f"{prefix}_CSR_{month_name}-{year}.csv"

def get_celec_data(endpoint, params):
    url = f"{BASE_URL}/{endpoint}"
    try:
        response = requests.get(url, params=params, timeout=TIMEOUT, verify=False)
        response.raise_for_status()
        return response.json().get('items', [])
    except Exception as e:
        print(f"  [!] Error consultando {endpoint}: {e}")
        return []

def download_data_for_date(date):
    target_date_str = date.strftime("%d/%m/%Y 00:00:00")
    iso_start = date.strftime("%Y-%m-%dT06:00:00.000Z")
    iso_end = (date + timedelta(days=1)).strftime("%Y-%m-%dT05:59:59.000Z")
    
    print(f"\n--- Procesando fecha: {date.strftime('%Y-%m-%d')} ---")

    # 1. Producción
    prod_row = {"Fecha": target_date_str}
    for col, endpoint in PROD_ENDPOINTS.items():
        items = get_celec_data(endpoint, {"fecha": target_date_str})
        if items:
            # La API devuelve 'valueedit' con valores horarios - sumamos para obtener energía diaria
            vals = [i.get('valueedit', 0) for i in items if i.get('valueedit') is not None]
            prod_row[col] = sum(vals) if vals else 0.0
        else:
            prod_row[col] = 0.0

    # 2. Hidrología
    hidro_row = {"Fecha": target_date_str}
    for col, mrid in HIDRO_MRIDS.items():
        params = {
            "mrid": mrid,
            "fechaInicio": iso_start,
            "fechaFin": iso_end,
            "fecha": target_date_str
        }
        items = get_celec_data("sardomcsr/pointValues", params)
        if items:
            # La API devuelve 'valueedit' - calculamos el promedio diario
            vals = [i.get('valueedit', 0) for i in items if i.get('valueedit') is not None]
            hidro_row[col] = sum(vals)/len(vals) if vals else 0.0
        else:
            hidro_row[col] = 0.0

    return prod_row, hidro_row

def save_to_csv(data_row, category, date):
    folder = "Produ_mensual" if category == "prod" else "Hidro_mensual"
    filename = get_monthly_filename(date, category)
    path = Path(folder) / filename
    
    df_new = pd.DataFrame([data_row])
    
    # Asegurar el orden de las columnas según el estándar detectado
    if category == "prod":
        cols_order = ["Fecha", "EnergiaCsr", "EnergiaMol", "EnergiaMaz", "EnergiaSop", "EnergiaMsf"]
    else:
        cols_order = ["Fecha", "CaudalCuencaPaute", "CaudalMol", "CotaMol", "CaudalMaz", "CotaMaz", "CaudalSop", "CotaSop", "CaudalMsf", "CotaMsf"]
    
    # Reordenar y asegurar que existan todas
    for c in cols_order:
        if c not in df_new.columns:
            df_new[c] = 0.0
    df_new = df_new[cols_order]

    if path.exists():
        try:
            # Intentar leer con varios encodings por si acaso
            exist = None
            for enc in ['utf-8-sig', 'latin-1', 'cp1252']:
                try:
                    exist = pd.read_csv(path, encoding=enc)
                    break
                except:
                    continue
            
            if exist is not None:
                # Normalizar fechas para comparar
                exist['Fecha_norm'] = pd.to_datetime(exist['Fecha'], dayfirst=True, errors='coerce')
                new_date_norm = pd.to_datetime(data_row['Fecha'], dayfirst=True)
                
                # Filtrar si la fecha ya existe (para actualizarla)
                exist = exist[exist['Fecha_norm'] != new_date_norm].drop(columns=['Fecha_norm'])
                df_final = pd.concat([exist, df_new]).sort_values('Fecha', ascending=False)
            else:
                df_final = df_new
        except Exception as e:
            print(f"  [!] Error al leer archivo existente {path}: {e}")
            df_final = df_new
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        df_final = df_new

    # Guardar con quotes para mantener compatibilidad con archivos originales
    df_final.to_csv(path, index=False, quoting=1, encoding='utf-8')
    print(f"  [OK] Guardado en {path}")

def main():
    # Por defecto, intentamos descargar los últimos 3 días para asegurar que no haya huevos por delays en la API
    today = datetime.now()
    # Si hoy es 22, descargamos 21, 20, 19
    days_to_download = 3
    
    # Intentamos descargar hoy (0) y los últimos 5 días para asegurar cobertura
    today = datetime.now()
    days_to_download = 5
    
    for i in range(0, days_to_download + 1):
        target_date = today - timedelta(days=i)
        prod, hidro = download_data_for_date(target_date)
        
        # Solo guardar si tenemos datos reales (opcional, pero ayuda a no llenar de ceros si la API falla)
        # Aquí verificamos si al menos una central tiene energía > 0
        has_prod = any(v > 0 for k, v in prod.items() if k != "Fecha")
        has_hidro = any(v > 0 for k, v in hidro.items() if k != "Fecha")
        
        if has_prod:
            save_to_csv(prod, "prod", target_date)
        else:
            print(f"  [!] Sin datos de producción para {target_date.strftime('%Y-%m-%d')}, saltando guardado.")
            
        if has_hidro:
            save_to_csv(hidro, "hidro", target_date)
        else:
            print(f"  [!] Sin datos de hidrología para {target_date.strftime('%Y-%m-%d')}, saltando guardado.")

if __name__ == "__main__":
    main()
