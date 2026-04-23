# CELEC PDF Robot

Robot para listar y descargar los informes PDF diarios del enlace publico de
CELECLOUD:

https://celecloud.celec.gob.ec/s/fH4f7pr5y9XBsxn

El script usa WebDAV publico de Nextcloud. No requiere paquetes externos de
Python.

## Uso

Vista previa, sin descargar:

```powershell
python .\celec_pdf_robot.py --dry-run
```

Descarga completa desde 2024-01-01 hasta la fecha mas reciente disponible:

```powershell
python .\celec_pdf_robot.py
```

Los PDFs quedan en:

```text
downloads/celec_pdfs/
```

El manifiesto CSV queda en:

```text
manifests/celec_pdfs_manifest.csv
```

## Opciones utiles

```powershell
python .\celec_pdf_robot.py --since 2025-01-01
python .\celec_pdf_robot.py --limit 10
python .\celec_pdf_robot.py --output-dir C:\datos\celec_pdfs
python .\celec_pdf_robot.py --delay 0.25
```

Si se ejecuta de nuevo, el robot omite los archivos que ya existen y tienen el
mismo tamano publicado por CELECLOUD.

## Programar en Windows

Ejemplo para ejecutarlo cada dia a las 07:00:

```powershell
schtasks /Create /SC DAILY /TN "CELEC PDF Robot" /TR "python C:\ruta\al\repo\celec_pdf_robot.py" /ST 07:00
```
