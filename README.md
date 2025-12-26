# CELEC Data Dashboard 📊

![Daily Update](https://github.com/jp1309/celec/actions/workflows/daily_update.yml/badge.svg)
![Python Version](https://img.shields.io/badge/python-3.11-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

Sistema automatizado de monitoreo y visualización de datos de **Producción Energética** e **Hidrología** de la Corporación Eléctrica del Ecuador (CELEC).

---

## 🚀 Descripción

Este proyecto recolecta, procesa y visualiza diariamente datos críticos del sector eléctrico ecuatoriano. Utiliza un bot programado en Python para extraer información de la API de CELEC y genera un dashboard interactivo publicado automáticamente mediante GitHub Pages.

### Módulos Principales:
- **Producción:** Datos de energía generada (MWh) por las centrales Molino, Mazar, Sopladora y Minas San Francisco.
- **Hidrología:** Monitoreo de caudales (m³/s) y cotas (msnm) de los embalses y cuencas principales.

---

## 🛠️ Arquitectura del Proyecto

El sistema opera bajo un flujo **ETL (Extract, Transform, Load)** automatizado:

1.  **Extracción (`download_data.py`):** Un bot consulta la API de CELEC cada 24 horas, descargando datos en tiempo real de los últimos 5 días para asegurar la integridad de la información.
2.  **Transformación (`build_datasets.py`):** Procesa los archivos mensuales individuales y los consolida en datasets de "formato largo" optimizados para visualización.
3.  **Carga y Automatización:** GitHub Actions ejecuta este flujo diariamente a las 00:00 (Ecuador), realiza un commit de los nuevos datos y actualiza el dashboard.

---

## 📂 Estructura del Repositorio

- `scripts/`: Código fuente de los bots de descarga y procesamiento.
- `Produ_mensual/`: Almacén histórico de archivos CSV de producción por mes.
- `Hidro_mensual/`: Almacén histórico de archivos CSV de hidrología por mes.
- `data/`: Datasets maestros consolidados (`produccion_diaria_larga.csv`, `hidrologia_diaria_larga.csv`).
- `public/`: Archivos del frontend del dashboard (HTML, CSS, JS).

---

## 💻 Configuración Local

Si deseas ejecutar el proyecto en tu entorno local:

### Requisitos
- Python 3.11+
- Git

### Instalación
1. Clonar el repositorio:
   ```bash
   git clone https://github.com/jp1309/celec.git
   cd celec
   ```
2. Instalar dependencias:
   ```bash
   pip install pandas requests urllib3
   ```
3. Ejecutar actualización manual:
   ```bash
   # Descargar datos nuevos
   python scripts/download_data.py
   # Construir datasets para el dashboard
   python scripts/build_datasets.py
   ```

---

## 📈 Dashboard

El dashboard es accesible de forma gratuita y se actualiza automáticamente.
🔗 **Link del Dashboard:** [jp1309.github.io/celec](https://jp1309.github.io/celec)

---

## 🛡️ Licencia

Este proyecto está bajo la Licencia MIT. Los datos son propiedad de CELEC y se utilizan únicamente con fines informativos y de visualización pública.

---
*Desarrollado con ❤️ para el monitoreo energético del Ecuador.*
