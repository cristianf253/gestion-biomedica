// Servidor de "Gestión Biomédica" — versión para desplegar en Render, accesible desde cualquier
// red (no solo la del hospital). Sigue sirviendo la aplicación (public/index.html) con la misma
// API HTTP de siempre, pero ahora:
//   - Los datos del inventario (app_state, su historial y las sesiones activas) se guardan en
//     Postgres (Supabase) en vez de en un archivo SQLite local — así varios perfiles pueden
//     trabajar a la vez sin que el archivo .db se vuelva un cuello de botella, y los datos no
//     dependen de que un computador en particular esté encendido.
//   - Los documentos adjuntos (PDFs, fotos, protocolos — varios GB en total) se SIGUEN guardando
//     como archivos sueltos en disco, no en la base de datos, exactamente igual que antes; en
//     Render ese disco es un "disco persistente" montado en DATA_DIR (ver render.yaml), para que
//     sobreviva a los despliegues y reinicios del servicio.
//
// Requiere Node.js 18+ y el paquete "pg" (ver package.json). A diferencia de la versión original
// (pensada para instalarse sin acceso a internet en un computador del hospital), esta versión SÍ
// se instala con "npm install" como parte del despliegue en Render, que tiene acceso a internet.
//
// Variables de entorno:
//   PORT            Puerto donde escucha el servidor (Render lo define solo).
//   DATABASE_URL    Cadena de conexión a Postgres (Supabase). Obligatoria.
//   APP_TOKEN       Si se define, la API exige este código de acceso (ver README.md).
//   DATA_DIR        Carpeta donde se guardan los documentos adjuntos. Por defecto "./data" (uso
//                   local); en Render se define como la ruta del disco persistente (ver render.yaml).
//   CORS_ORIGIN     Si se define, se permite ese origen (o "*") en las respuestas de la API — hace
//                   falta solo para herramientas administrativas puntuales que llaman a esta API
//                   desde otro origen (p. ej. la migración inicial de documentos); la app normal
//                   siempre se sirve desde el mismo origen y no lo necesita.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const APP_TOKEN = process.env.APP_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DOCUMENTOS_DIR = path.join(DATA_DIR, 'documentos');
const HISTORY_KEEP = 200; // cuántas versiones anteriores conservar en el historial de respaldo
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

if(!process.env.DATABASE_URL){
  console.error('Falta la variable de entorno DATABASE_URL (cadena de conexión a Postgres/Supabase). El servidor no puede arrancar sin ella.');
  process.exit(1);
}

fs.mkdirSync(DOCUMENTOS_DIR, { recursive: true });

// Supabase exige SSL; "rejectUnauthorized:false" porque el entorno de Render no siempre trae las
// mismas autoridades certificadoras preinstaladas que necesitaría para validar la cadena completa
// de Supabase — la conexión sigue cifrada, solo no se verifica el certificado contra una CA local.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data JSONB NOT NULL,
    version INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS app_state_history (
    id BIGSERIAL PRIMARY KEY,
    version INTEGER NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_app_state_history_id_desc ON app_state_history (id DESC);
  CREATE TABLE IF NOT EXISTS documentos (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    tamano BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS active_sessions (
    responsable_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    device_label TEXT,
    updated_at TIMESTAMPTZ NOT NULL
  );
`).catch(e=>{
  console.error('No se pudo preparar el esquema en Postgres al arrancar:', e.message);
});

// ---------------------------------------------------------------------------------------------
// Sesión única por cuenta (responsable) — misma lógica que la versión original, ahora en Postgres.
async function reclamarSesion(responsableId, token, deviceLabel){
  const ahora = new Date().toISOString();
  await pool.query(`
    INSERT INTO active_sessions (responsable_id, token, device_label, updated_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (responsable_id) DO UPDATE SET token=excluded.token, device_label=excluded.device_label, updated_at=excluded.updated_at
  `, [responsableId, token, deviceLabel || null, ahora]);
}
async function sesionVigente(responsableId, token){
  const { rows } = await pool.query('SELECT token FROM active_sessions WHERE responsable_id = $1', [responsableId]);
  if(!rows[0]) return true;
  return rows[0].token === token;
}

async function getEstadoActual(){
  const { rows } = await pool.query('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = 1');
  return rows[0] || null;
}

// Guarda una nueva versión del estado de forma atómica: si baseVersion no coincide con la versión
// vigente en ese momento, no escribe nada y devuelve el conflicto — igual que la versión original,
// ahora con una transacción de Postgres y un bloqueo de fila (FOR UPDATE) en vez de BEGIN IMMEDIATE
// de SQLite, para la misma garantía: dos guardados al mismo tiempo nunca se pisan entre sí.
async function guardarEstado(dataStr, baseVersion, updatedBy){
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT version, updated_at, updated_by, data FROM app_state WHERE id = 1 FOR UPDATE');
    const actual = rows[0] || null;
    const versionActual = actual ? actual.version : 0;
    if(actual && baseVersion !== versionActual){
      await client.query('ROLLBACK');
      return {
        ok:false, code:'conflict', version: versionActual,
        updatedAt: actual.updated_at, updatedBy: actual.updated_by, data: actual.data,
      };
    }
    const nuevaVersion = versionActual + 1;
    const ahora = new Date().toISOString();
    if(actual){
      await client.query('UPDATE app_state SET data=$1, version=$2, updated_at=$3, updated_by=$4 WHERE id=1', [dataStr, nuevaVersion, ahora, updatedBy || null]);
    } else {
      await client.query('INSERT INTO app_state (id, data, version, updated_at, updated_by) VALUES (1,$1,$2,$3,$4)', [dataStr, nuevaVersion, ahora, updatedBy || null]);
    }
    await client.query('INSERT INTO app_state_history (version, data, updated_at, updated_by) VALUES ($1,$2,$3,$4)', [nuevaVersion, dataStr, ahora, updatedBy || null]);
    await client.query('DELETE FROM app_state_history WHERE id IN (SELECT id FROM app_state_history ORDER BY id DESC OFFSET $1)', [HISTORY_KEEP]);
    await client.query('COMMIT');
    return { ok:true, version: nuevaVersion, updatedAt: ahora };
  }catch(e){
    try{ await client.query('ROLLBACK'); }catch(e2){}
    return { ok:false, code:'error', message: e.message };
  }finally{
    client.release();
  }
}

function esErrorDeDiscoLleno(e){
  const texto = String((e && e.message) || '') + ' ' + String((e && e.code) || '');
  return /ENOSPC|no space|disk.*full/i.test(texto);
}

function tokenValido(req){
  if(!APP_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return !!m && m[1] === APP_TOKEN;
}

function enviarJson(res, status, obj){
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  if(CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
  res.writeHead(status, headers);
  res.end(body);
}

function leerCuerpo(req){
  return new Promise((resolve, reject)=>{
    const partes = [];
    req.on('data', chunk=>{ partes.push(chunk); });
    req.on('end', ()=>resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------
// Documentos adjuntos: igual que la versión original — el contenido se guarda en disco (bytes
// decodificados, no base64) y en la base de datos solo queda una fila liviana con tipo/tamaño/fecha.
const RUTA_DATA_URL = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]*)$/;

function rutaDocumento(id){
  return path.join(DOCUMENTOS_DIR, id);
}

async function guardarDocumento(id, dataUrl){
  const m = RUTA_DATA_URL.exec(dataUrl || '');
  if(!m) return { ok:false, code:'bad_request' };
  const mime = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  const ruta = rutaDocumento(id);
  const rutaTemporal = ruta + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try{
    fs.writeFileSync(rutaTemporal, bytes);
    fs.renameSync(rutaTemporal, ruta);
  }catch(e){
    try{ fs.unlinkSync(rutaTemporal); }catch(e2){}
    return { ok:false, code: esErrorDeDiscoLleno(e) ? 'disk_full' : 'error', message: e.message };
  }
  const ahora = new Date().toISOString();
  try{
    await pool.query(`
      INSERT INTO documentos (id, mime, tamano, updated_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET mime=excluded.mime, tamano=excluded.tamano, updated_at=excluded.updated_at
    `, [id, mime, bytes.length, ahora]);
  }catch(e){
    return { ok:false, code:'error', message: e.message };
  }
  return { ok:true };
}

async function leerDocumento(id){
  const { rows } = await pool.query('SELECT mime, tamano FROM documentos WHERE id = $1', [id]);
  const fila = rows[0];
  if(!fila) return null;
  let bytes;
  try{ bytes = fs.readFileSync(rutaDocumento(id)); }
  catch(e){ return null; }
  const dataUrl = `data:${fila.mime};base64,${bytes.toString('base64')}`;
  return { dataUrl };
}

async function borrarDocumento(id){
  await pool.query('DELETE FROM documentos WHERE id = $1', [id]);
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
    if(CORS_ORIGIN && req.method === 'OPTIONS'){
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }
    if(url === '/api/health'){
      enviarJson(res, 200, { ok:true });
      return;
    }
    if(url.startsWith('/api/state')){
      if(!tokenValido(req)){ enviarJson(res, 401, { ok:false, code:'unauthorized' }); return; }
      if(req.method === 'GET'){
        const actual = await getEstadoActual();
        if(!actual){ enviarJson(res, 200, { ok:true, state:null, version:0, updatedAt:null }); return; }
        enviarJson(res, 200, { ok:true, state: actual.data, version: actual.version, updatedAt: actual.updated_at, updatedBy: actual.updated_by });
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
        const resultado = await guardarEstado(dataStr, baseVersion, updatedBy);
        if(resultado.ok){
          enviarJson(res, 200, { ok:true, version: resultado.version, updatedAt: resultado.updatedAt });
        } else if(resultado.code === 'conflict'){
          enviarJson(res, 409, { ok:false, code:'conflict', state: resultado.data, version: resultado.version, updatedAt: resultado.updatedAt, updatedBy: resultado.updatedBy });
        } else if(resultado.code === 'disk_full'){
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
        await reclamarSesion(payload.responsableId, payload.token, deviceLabel);
        enviarJson(res, 200, { ok:true });
        return;
      }
      if(url.startsWith('/api/session/check')){
        if(req.method !== 'GET'){ enviarJson(res, 405, { ok:false, code:'method_not_allowed' }); return; }
        const parsedUrl = new URL(url, 'http://localhost');
        const responsableId = parsedUrl.searchParams.get('responsableId') || '';
        const token = parsedUrl.searchParams.get('token') || '';
        if(!responsableId || !token){ enviarJson(res, 400, { ok:false, code:'bad_request' }); return; }
        enviarJson(res, 200, { ok:true, valid: await sesionVigente(responsableId, token) });
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
        const doc = await leerDocumento(id);
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
        const resultado = await guardarDocumento(id, payload.dataUrl);
        if(resultado.ok){ enviarJson(res, 200, { ok:true }); }
        else if(resultado.code === 'disk_full'){ enviarJson(res, 507, { ok:false, code:'disk_full', message: resultado.message }); }
        else if(resultado.code === 'bad_request'){ enviarJson(res, 400, { ok:false, code:'bad_request' }); }
        else { enviarJson(res, 500, { ok:false, code:'error', message: resultado.message }); }
        return;
      }
      if(req.method === 'DELETE'){
        await borrarDocumento(id);
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
  console.log(`Documentos adjuntos: ${DOCUMENTOS_DIR}`);
  if(APP_TOKEN) console.log('Código de acceso requerido (APP_TOKEN definido).');
  else console.log('Sin código de acceso configurado: cualquiera que alcance esta URL puede leer y guardar datos. Revisa README.md — ahora que es accesible desde cualquier red, se recomienda definir APP_TOKEN.');
});
