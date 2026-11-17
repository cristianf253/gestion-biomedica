# Gestión Biomédica — despliegue en Render + Supabase

Esta carpeta es la versión de `gestion-biomedica-server` preparada para correr en Render,
accesible desde cualquier red (no solo la del hospital). La aplicación (`public/index.html`) es
exactamente la misma que la que corre en el computador del hospital — no se le cambió nada; todos
los cambios están en `server.js`.

## Qué cambió respecto a la versión original

- Los datos del inventario (`app_state`, su historial y las sesiones activas) ahora se guardan en
  **Postgres (Supabase)** en vez de en un archivo SQLite local, usando el paquete `pg`.
- Los **documentos adjuntos** (PDFs, fotos, protocolos — varios GB) siguen guardándose como
  archivos sueltos en disco, exactamente igual que antes. En Render viven en un **disco
  persistente** montado en `/data` (ver `render.yaml`), para que sobrevivan a los despliegues.
- La API HTTP que usa `index.html` (`/api/state`, `/api/session/*`, `/api/docs/*`) no cambió en
  nada — el navegador no nota ninguna diferencia.

## Variables de entorno que hay que configurar en Render (panel de Render, no en este repositorio)

- `DATABASE_URL` — cadena de conexión a Postgres de Supabase (Project Settings → Database →
  Connection string). **Nunca se sube al repositorio.**
- `APP_TOKEN` — código de acceso para la API. Ahora que la app es accesible desde cualquier red,
  se recomienda definir uno (antes era opcional porque solo se podía llegar desde la red del
  hospital).
- `DATA_DIR` — ya viene definida en `render.yaml` como `/data` (el disco persistente).

## Migración de los datos existentes

1. Los datos del inventario (equipos, historial) se migran una sola vez al proyecto de Supabase
   antes del primer despliegue real — ver instrucciones aparte.
2. Los documentos adjuntos (5.5 GB, miles de archivos) se migran con una herramienta temporal
   dentro de la misma app ("Migración de documentos a Render"), que copia cada archivo desde el
   servidor del hospital hacia la nueva URL de Render, en lotes, con una barra de progreso. Se
   quita del menú de administrador una vez termine.

## Después de migrar y confirmar que todo funciona bien en la nueva URL

El servidor del computador del hospital puede seguir corriendo como respaldo local, o apagarse —
a partir de ese momento la fuente de datos real es la de Render + Supabase, y las dos copias NO
se sincronizan solas entre sí.
