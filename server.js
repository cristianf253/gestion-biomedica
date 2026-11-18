// Servidor de "Gestión Biomédica" — versión para desplegar en Render, accesible desde cualquier
// red (no solo la del hospital). Es el MISMO servidor que corre en el computador del hospital
// (SQLite local con el módulo node:sqlite, sin dependencias externas) — no se le cambió ninguna
// lógica. La única diferencia es que la carpeta de datos (base de datos + documentos adjuntos) se
// puede ubicar en otra ruta mediante la variable de entorno DATA_DIR, para que apunte al disco
// persistente que monta Render (ver render.yaml) en vez de a una carpeta relativa al proyecto.
//
// Requiere Node.js 22.5 o superior (usa el módulo node:sqlite, incluido con Node — no hace falta
// instalar ningún paquete con npm; ver render.yaml / package.json para la versión exacta fijada
// en Render).
//
// Variables de entorno:
//   PORT            Puerto donde escucha el servidor (Render lo define solo).
//   APP_TOKEN       Si se define, la API exige este código de acceso (ver README.md) para leer o
//                   guardar datos. Ahora que el servicio es accesible desde cualquier red (ya no
//                   solo la del hospital), se recomienda definirlo en el panel de Render.
//   DATA_DIR        Carpeta donde se guardan la base de datos y los documentos adjuntos. Por
//                   defecto "./data" (uso local, igual que en el hospital); en Render se define
//                   como la ruta del disco persistente (ver render.yaml).
//
// Nota sobre el tamaño de los datos: no hay ningún límite fijo de bytes para guardar. El único
// límite real es el espacio libre en el disco persistente — si se queda sin espacio, el guardado
// falla con un aviso claro y específico (ver guardarEstado más abajo) en vez de un límite
// arbitrario elegido de antemano.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const APP_TOKEN = process.env.APP_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'gestion-biomedica.db');
const DOCUMENTOS_DIR = path.join(DATA_DIR, 'documentos'); // contenido real de cada documento (ver más abajo)
const HISTORY_KEEP = 200; // cuántas versiones anteriores conservar en el historial de respaldo

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOCUMENTOS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
// Activa auto_vacuum en modo FULL: cada vez que se borran filas viejas del historial de respaldo
// (ver HISTORY_KEEP), SQLite libera ese espacio de vuelta al archivo automáticamente en cada
// guardado, en vez de dejarlo "atrapado" para siempre dentro del archivo .db. En una base de datos
// recién creada (como la de un despliegue nuevo en Render) este modo queda activo desde el primer
// guardado, así que el archivo se mantiene liviano sin necesitar ningún mantenimiento manual.
db.exec('PRAGMA auto_vacuum = FULL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS app_state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS documentos (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    tamano INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS active_sessions (
    responsable_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    device_label TEXT,
    updated_at TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------------------------------------
// Sesión única por cuenta (responsable)
//
// Cada vez que alguien inicia sesión en el navegador (ver submitLogin/restaurarSesionGuardada en
// index.html) se genera ahí un identificador aleatorio ("token") para ese inicio de sesión y se
// manda aquí con /api/session/claim, que lo guarda como el ÚNICO token vigente para ese
// responsable — sobrescribiendo sin preguntar el que hubiera antes, porque la regla es "el último
// que inicia sesión con esa cuenta se queda con ella". El navegador que inició sesión antes sigue
// guardando en localStorage el token viejo, y cada cierto tiempo pregunta con /api/session/check
// si todavía es el vigente; en cuanto deja de serlo (porque alguien volvió a iniciar sesión con la
// misma cuenta en otro dispositivo), ese navegador se cierra solo y vuelve a pedir usuario y
// contraseña, con un aviso explicando por qué. Si un responsable nunca reclamó sesión desde que
// existe esta tabla (no hay fila para él todavía), se trata como vigente para no cerrarle la
// sesión a nadie que ya estuviera adentro antes de este cambio.
function reclamarSesion(responsableId, token, deviceLabel){
  const ahora = new Date().toISOString();
  db.prepare(`
    INSERT INTO active_sessions (responsable_id, token, device_label, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(responsable_id) DO UPDATE SET token=excluded.token, device_label=excluded.device_label, updated_at=excluded.updated_at
  `).run(responsableId, token, deviceLabel || null, ahora);
}
function sesionVigente(responsableId, token){
  const fila = db.prepare('SELECT token FROM active_sessions WHERE responsable_id = ?').get(responsableId);
  if(!fila) return true;
  return fila.token === token;
}

function getEstadoActual(){
  return db.prepare('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = 1').get();
}

// Guarda una nueva versión del estado de forma atómica: si baseVersion no coincide con la versión
// vigente en ese momento, no escribe nada y devuelve el conflicto (para que quien guarda pueda
// avisar y volver a cargar los datos más recientes en vez de sobrescribir silenciosamente el
// trabajo de otra persona que guardó desde otro navegador un momento antes).
function guardarEstado(dataStr, baseVersion, updatedBy){
  const resultado = { ok:false };
  db.exec('BEGIN IMMEDIATE');
  try{
    const actual = getEstadoActual();
    const versionActual = actual ? actual.version : 0;
    if(actual && baseVersion !== versionActual){
      db.exec('ROLLBACK');
      resultado.ok = false;
      resultado.code = 'conflict';
      resultado.version = versionActual;
      resultado.updatedAt = actual.updated_at;
      resultado.updatedBy = actual.updated_by;
      resultado.data = actual.data;
      return resultado;
    }
    const nuevaVersion = versionActual + 1;
    const ahora = new Date().toISOString();
    if(actual){
      db.prepare('UPDATE app_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
        .run(dataStr, nuevaVersion, ahora, updatedBy || null);
    } else {
      db.prepare('INSERT INTO app_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)')
        .run(dataStr, nuevaVersion, ahora, updatedBy || null);
    }
    db.prepare('INSERT INTO app_state_history (version, data, updated_at, updated_by) VALUES (?, ?, ?, ?)')
      .run(nuevaVersion, dataStr, ahora, updatedBy || null);
    db.prepare(`DELETE FROM app_state_history WHERE id IN (
        SELECT id FROM app_state_history ORDER BY id DESC LIMIT -1 OFFSET ?
      )`).run(HISTORY_KEEP);
    db.exec('COMMIT');
    resultado.ok = true;
    resultado.version = nuevaVersion;
    resultado.updatedAt = ahora;
    return resultado;
  }catch(e){
    try{ db.exec('ROLLBACK'); }catch(e2){}
    resultado.ok = false;
    resultado.code = esErrorDeDiscoLleno(e) ? 'disk_full' : 'error';
    resultado.message = e.message;
    return resultado;
  }
}

// Detecta si el error viene de que el disco del servidor se quedó sin espacio (SQLite lo reporta
// como "SQLITE_FULL" / "database or disk is full"; el sistema operativo, como ENOSPC) — para poder
// avisar con un mensaje específico y honesto ("el servidor se quedó sin espacio en disco") en vez de
// un genérico "ocurrió un error", ya que es la única razón real por la que un guardado debería fallar
// por tamaño (no hay ningún límite de bytes fijado de antemano).
function esErrorDeDiscoLleno(e){
  const texto = String((e && e.message) || '') + ' ' + String((e && e.code) || '');
  return /SQLITE_FULL|disk.*full|no space|ENOSPC/i.test(texto);
}

function tokenValido(req){
  if(!APP_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return !!m && m[1] === APP_TOKEN;
}

function enviarJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Sin límite de bytes fijado de antemano: se recibe y acumula todo lo que envíe el navegador. El
// único límite real es el espacio en disco (ver esErrorDeDiscoLleno) y la memoria disponible en la
// instancia donde corre el servidor — no una cifra arbitraria elegida sin conocer el uso real.
function leerCuerpo(req){
  return new Promise((resolve, reject)=>{
    const partes = [];
    req.on('data', chunk=>{ partes.push(chunk); });
    req.on('end', ()=>resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------
// Documentos adjuntos (PDFs, fotos, protocolos escaneados, checklists…)
//
// El navegador (ver guardarContenidoDocumento/contenidoDocumento en index.html) guarda y pide el
// contenido de cada documento por separado del resto de los datos, mandándolo como una "data URL"
// (texto base64 con el prefijo "data:<tipo>;base64,...") a PUT/GET/DELETE /api/docs/:id.
//
// Para que esto aguante bien un volumen grande de documentos (muchos PDFs, o algunos pesados), el
// contenido NO se guarda como texto base64 dentro de la base de datos (eso infla cada archivo ~33%
// y hace crecer mucho el archivo .db); se guarda el archivo ya decodificado, en bytes, directo en
// disco (DATA_DIR/documentos/ — en Render, dentro del disco persistente), y en SQLite solo queda
// una fila liviana con su tipo, tamaño y fecha. El navegador no nota ninguna diferencia: sigue
// mandando y recibiendo exactamente la misma "data URL" de siempre.
const RUTA_DATA_URL = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]*)$/;

function rutaDocumento(id){
  return path.join(DOCUMENTOS_DIR, id);
}

function guardarDocumento(id, dataUrl){
  const m = RUTA_DATA_URL.exec(dataUrl || '');
  if(!m) return { ok:false, code:'bad_request' };
  const mime = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  const ruta = rutaDocumento(id);
  const rutaTemporal = ruta + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try{
    fs.writeFileSync(rutaTemporal, bytes);
    fs.renameSync(rutaTemporal, ruta); // atómico: nunca deja a medio escribir el archivo final
  }catch(e){
    try{ fs.unlinkSync(rutaTemporal); }catch(e2){}
    return { ok:false, code: esErrorDeDiscoLleno(e) ? 'disk_full' : 'error', message: e.message };
  }
  const ahora = new Date().toISOString();
  db.prepare(`
    INSERT INTO documentos (id, mime, tamano, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET mime=excluded.mime, tamano=excluded.tamano, updated_at=excluded.updated_at
  `).run(id, mime, bytes.length, ahora);
  return { ok:true };
}

function leerDocumento(id){
  const fila = db.prepare('SELECT mime, tamano FROM documentos WHERE id = ?').get(id);
  if(!fila) return null;
  let bytes;
  try{ bytes = fs.readFileSync(rutaDocumento(id)); }
  catch(e){ return null; } // fila sin archivo (no debería pasar; se trata igual que "no existe")
  const dataUrl = `data:${fila.mime};base64,${bytes.toString('base64')}`;
  return { dataUrl };
}

function borrarDocumento(id){
  db.prepare('DELETE FROM documentos WHERE id = ?').run(id);
  try{ fs.unlinkSync(rutaDocumento(id)); }catch(e){ /* ya no existía: no es un error */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

function servirArchivoEstatico(req, res, urlPath){
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const resuelto = path.normalize(path.join(PUBLIC_DIR, rel));
  if(!resuelto.startsWith(PUBLIC_DIR)){ res.writeHead(403); res.end('Prohibido'); return; }
  fs.readFile(resuelto, (err, contenido)=>{
    if(err){ res.writeHead(404); res.end('No encontrado'); return; }
    const ext = path.extname(resuelto).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(contenido);
  });
}

const server = http.createServer(async (req, res)=>{
  const url = req.url || '/';
  try{
    if(url === '/api/health'){
      enviarJson(res, 200, { ok:true });
      return;
    }
    if(url.startsWith('/api/state')){
      if(!tokenValido(req)){ enviarJson(res, 401, { ok:false, code:'unauthorized' }); return; }
      if(req.method === 'GET'){
        const actual = getEstadoActual();
        if(!actual){ enviarJson(res, 200, { ok:true, state:null, version:0, updatedAt:null }); return; }
        enviarJson(res, 200, { ok:true, state: JSON.parse(actual.data), version: actual.version, updatedAt: actual.updated_at, updatedBy: actual.updated_by });
        return;
      }
      if(req.method === 'POST'){
        let cuerpo;
        try{ cuerpo = await leerCuerpo(req); }
        catch(e){ enviarJson(res, 400, { ok:false, code:'read_error', message: e.message }); return; }
        let payload;
        try{ payload = JSON.parse(cuerpo); }
        catch(e){ enviarJson(res, 400, { ok:false, code:'bad_json' }); return; }
        if(!payload || typeof payload !== 'object' || !payload.state){
          enviarJson(res, 400, { ok:false, code:'bad_request' });
          return;
        }
        const baseVersion = Number.isFinite(payload.baseVersion) ? payload.baseVersion : 0;
        const dataStr = JSON.stringify(payload.state);
        const updatedBy = typeof payload.updatedBy === 'string' ? payload.updatedBy.slice(0,120) : null;
        const resultado = guardarEstado(dataStr, baseVersion, updatedBy);
        if(resultado.ok){
          enviarJson(res, 200, { ok:true, version: resultado.version, updatedAt: resultado.updatedAt });
        } else if(resultado.code === 'conflict'){
          enviarJson(res, 409, { ok:false, code:'conflict', state: JSON.parse(resultado.data), version: resultado.version, updatedAt: resultado.updatedAt, updatedBy: resultado.updatedBy });
        } else if(resultado.code === 'disk_full'){
          // 507 Insufficient Storage: el único límite real que le queda al guardado — no un tamaño
          // arbitrario, sino que el disco persistente ya no tiene espacio.
          enviarJson(res, 507, { ok:false, code:'disk_full', message: resultado.message });
        } else {
          enviarJson(res, 500, { ok:false, code:'error', message: resultado.message });
        }
        return;
      }
      enviarJson(res, 405, { ok:false, code:'method_not_allowed' });
      return;
    }
    if(url.startsWith('/api/session/')){
      if(!tokenValido(req)){ enviarJson(res, 401, { ok:false, code:'unauthorized' }); return; }
      if(url.startsWith('/api/session/claim')){
        if(req.method !== 'POST'){ enviarJson(res, 405, { ok:false, code:'method_not_allowed' }); return; }
        let cuerpo;
        try{ cuerpo = await leerCuerpo(req); }
        catch(e){ enviarJson(res, 400, { ok:false, code:'read_error', message: e.message }); return; }
        let payload;
        try{ payload = JSON.parse(cuerpo); }
        catch(e){ enviarJson(res, 400, { ok:false, code:'bad_json' }); return; }
        if(!payload || typeof payload.responsableId !== 'string' || !payload.responsableId || typeof payload.token !== 'string' || !payload.token){
          enviarJson(res, 400, { ok:false, code:'bad_request' });
          return;
        }
        const deviceLabel = typeof payload.deviceLabel === 'string' ? payload.deviceLabel.slice(0,120) : null;
        reclamarSesion(payload.responsableId, payload.token, deviceLabel);
        enviarJson(res, 200, { ok:true });
        return;
      }
      if(url.startsWith('/api/session/check')){
        if(req.method !== 'GET'){ enviarJson(res, 405, { ok:false, code:'method_not_allowed' }); return; }
        const parsedUrl = new URL(url, 'http://localhost');
        const responsableId = parsedUrl.searchParams.get('responsableId') || '';
        const token = parsedUrl.searchParams.get('token') || '';
        if(!responsableId || !token){ enviarJson(res, 400, { ok:false, code:'bad_request' }); return; }
        enviarJson(res, 200, { ok:true, valid: sesionVigente(responsableId, token) });
        return;
      }
      enviarJson(res, 404, { ok:false, code:'not_found' });
      return;
    }
    if(url.startsWith('/api/docs/')){
      if(!tokenValido(req)){ enviarJson(res, 401, { ok:false, code:'unauthorized' }); return; }
      const id = decodeURIComponent(url.slice('/api/docs/'.length).split('?')[0]);
      if(!id || /[\\/]/.test(id)){ enviarJson(res, 400, { ok:false, code:'bad_id' }); return; }

      if(req.method === 'GET'){
        const doc = leerDocumento(id);
        if(!doc){ enviarJson(res, 404, { ok:false, code:'not_found' }); return; }
        enviarJson(res, 200, { ok:true, dataUrl: doc.dataUrl });
        return;
      }
      if(req.method === 'PUT'){
        let cuerpo;
        try{ cuerpo = await leerCuerpo(req); }
        catch(e){ enviarJson(res, 400, { ok:false, code:'read_error', message: e.message }); return; }
        let payload;
        try{ payload = JSON.parse(cuerpo); }
        catch(e){ enviarJson(res, 400, { ok:false, code:'bad_json' }); return; }
        if(!payload || typeof payload.dataUrl !== 'string'){
          enviarJson(res, 400, { ok:false, code:'bad_request' });
          return;
        }
        const resultado = guardarDocumento(id, payload.dataUrl);
        if(resultado.ok){ enviarJson(res, 200, { ok:true }); }
        else if(resultado.code === 'disk_full'){ enviarJson(res, 507, { ok:false, code:'disk_full', message: resultado.message }); }
        else if(resultado.code === 'bad_request'){ enviarJson(res, 400, { ok:false, code:'bad_request' }); }
        else { enviarJson(res, 500, { ok:false, code:'error', message: resultado.message }); }
        return;
      }
      if(req.method === 'DELETE'){
        borrarDocumento(id);
        enviarJson(res, 200, { ok:true });
        return;
      }
      enviarJson(res, 405, { ok:false, code:'method_not_allowed' });
      return;
    }
    if(req.method === 'GET'){
      servirArchivoEstatico(req, res, url);
      return;
    }
    res.writeHead(404); res.end('No encontrado');
  }catch(e){
    enviarJson(res, 500, { ok:false, code:'error', message: e.message });
  }
});

server.listen(PORT, ()=>{
  console.log(`Gestión Biomédica escuchando en el puerto ${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
  console.log(`Documentos adjuntos: ${DOCUMENTOS_DIR}`);
  if(APP_TOKEN) console.log('Código de acceso requerido (APP_TOKEN definido).');
  else console.log('Sin código de acceso configurado: cualquiera que alcance esta URL puede leer y guardar datos. Revisa README.md — ahora que es accesible desde cualquier red, se recomienda definir APP_TOKEN.');
});
