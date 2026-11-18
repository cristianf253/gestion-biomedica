Gestión Biomédica — despliegue en Render
Esta carpeta es la versión de `gestion-biomedica-server` preparada para correr en Render,
accesible desde cualquier red (no solo la del hospital). La aplicación (`public/index.html`) es
exactamente la misma que la que corre en el computador del hospital, y `server.js` también es el
mismo servidor (SQLite local con el módulo `node:sqlite`, sin dependencias externas) — no se le
cambió ninguna lógica. La única diferencia con la versión del hospital es que la carpeta de datos
se puede definir con la variable de entorno `DATA_DIR`, para que apunte al disco persistente de
Render en vez de a una carpeta relativa al proyecto.
Qué guarda cada cosa y dónde
`app_state` (el inventario completo, su historial de hasta 200 versiones y las sesiones
activas) y los documentos adjuntos (PDFs, fotos, protocolos) viven juntos, dentro del mismo
disco persistente de Render, montado en `/data` (ver `render.yaml`): la base de datos en
`/data/gestion-biomedica.db` y cada documento como archivo suelto en `/data/documentos/`.
No se usa Postgres ni Supabase ni ningún servicio externo — todo queda en ese único disco.
La API HTTP que usa `index.html` (`/api/state`, `/api/session/*`, `/api/docs/*`) es la misma de
siempre — el navegador no nota ninguna diferencia.
Variables de entorno que hay que configurar en el panel de Render
`APP_TOKEN` — código de acceso para la API. Ahora que la app es accesible desde cualquier red
(ya no solo la del hospital), es importante definir uno — ver advertencia de seguridad más abajo.
`DATA_DIR` y `NODE_VERSION` — ya vienen definidas en `render.yaml`, no hay que tocarlas a mano.
Antes de migrar: compactar la base de datos actual
El archivo `gestion-biomedica.db` del hospital puede pesar mucho más de lo que ocupan los datos
reales, porque el modo que libera ese espacio automáticamente (`auto_vacuum`) solo se activó
recientemente. Antes de copiar los datos a Render conviene correr una sola vez, en el computador
del hospital y con el servidor apagado:
```
node mantenimiento_vacuum.js
```
Esto reconstruye el archivo sin perder ningún dato y debería dejarlo mucho más liviano — reduce
tanto el tamaño a migrar como el disco que hace falta contratar en Render. De ahí en adelante el
archivo se mantiene compacto solo (no hay que repetir este paso).
Migración de los datos existentes
Inventario (`gestion-biomedica.db`): se puede copiar el archivo tal cual (ya compactado,
ver arriba) al disco persistente de Render antes del primer arranque, o volver a subir el
estado completo desde la app una vez que el servicio esté corriendo — se puede planear el
método exacto cuando se vaya a ejecutar el despliegue.
Documentos adjuntos (miles de archivos, varios GB): se migran con una herramienta temporal
dentro de la misma app ("Migración de documentos a Render"), que copia cada archivo desde el
servidor del hospital hacia la nueva URL de Render, en lotes, con una barra de progreso. Se
quita del menú de administrador una vez termine.
Después de migrar y confirmar que todo funciona bien en la nueva URL
El servidor del computador del hospital puede seguir corriendo como respaldo local, o apagarse —
a partir de ese momento la fuente de datos real es la de Render, y las dos copias NO se
sincronizan solas entre sí.
Seguridad
Igual que en la versión del hospital, el inicio de sesión (usuario/contraseña) es solo una capa
visual dentro de la app, no autenticación real del servidor: cualquiera que conozca la URL del
servicio en Render puede leer y escribir los datos a través de `/api/state` sin pasar por la
pantalla de inicio de sesión. Como ahora el servicio es accesible desde cualquier red (ya no solo
la del hospital), es importante definir `APP_TOKEN` en el panel de Render — ver la sección
correspondiente en el `README.md` de la versión del hospital para el detalle de cómo funciona.
