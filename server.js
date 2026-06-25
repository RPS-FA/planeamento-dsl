// ============================================================
// Planeamento DSL — Servidor Express + API REST + Postgres
// ============================================================
// Serve o frontend (public/) e expõe a API JSON usada pelo cliente.
//   GET    /api/state          — {ops, settings, ts}
//   GET    /api/ops            — {ops:[...]}
//   POST   /api/ops            — cria nova ordem (perfil planeador)
//   PUT    /api/ops/:id        — actualiza (planeador OU produção c/ whitelist)
//   DELETE /api/ops/:id        — apaga (planeador)
//   GET    /api/settings       — {settings:{...}}
//   PUT    /api/settings       — substitui chaves enviadas
//   POST   /api/admin/wipe     — apaga todas (planeador)
//   POST   /api/admin/reset    — apaga + re-seed (planeador)
//   GET    /health             — healthcheck Railway
// Header X-Profile: 'planeador' (default) | 'producao'
// ============================================================

const express = require('express');
const compression = require('compression');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  next();
});

// Campos editáveis pelo perfil "producao" (pós-execução / chão de fábrica)
const PRODUCAO_FIELDS = [
  'estado',
  'hInicioR', 'hFimR', 'horaFecho', 'dataFimTurno', 'terminou',
  'tempoAtraso', 'temposPerdidosAvaria', 'faltas',
  'qtdReal', 'qtdSeguinte', 'lote',
  'motivo2aPassagem', 'causaRaiz2a', 'qtdDesdobramento',
  'qvUpDsl', 'qvDsl', 'qvDownDsl', 'qv1Dsl',
  'colaborador', 'obs',
];

function profileOf(req) {
  const h = (req.get('X-Profile') || '').toLowerCase();
  return h === 'producao' ? 'producao' : 'planeador';
}
function requireDb(res) {
  if (!db.isConnected()) {
    res.status(503).json({ ok: false, error: 'BD indisponível (DATABASE_URL não configurada).' });
    return false;
  }
  return true;
}
function sendError(res, e, fallback) {
  const msg = (e && e.message) || fallback || 'erro desconhecido';
  console.error('[api]', msg, e && e.stack ? '\n' + e.stack : '');
  res.status(500).json({ ok: false, error: msg });
}

app.get('/api/state', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const [ops, settings] = await Promise.all([db.listOps(), db.getSettings()]);
    res.json({ ops, settings, ts: new Date().toISOString() });
  } catch (e) { sendError(res, e, 'GET /api/state falhou'); }
});

app.get('/api/ops', async (req, res) => {
  if (!requireDb(res)) return;
  try { res.json({ ops: await db.listOps() }); }
  catch (e) { sendError(res, e, 'GET /api/ops falhou'); }
});

app.post('/api/ops', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (profileOf(req) !== 'planeador')
      return res.status(403).json({ ok: false, error: 'Apenas o perfil planeador pode criar ordens.' });
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body))
      return res.status(400).json({ ok: false, error: 'Body inválido.' });
    res.json({ ok: true, op: await db.createOp(body, 'planeador') });
  } catch (e) { sendError(res, e, 'POST /api/ops falhou'); }
});

app.put('/api/ops/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const profile = profileOf(req);
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body))
      return res.status(400).json({ ok: false, error: 'Body inválido.' });

    let merged;
    if (profile === 'producao') {
      const current = await db.getOp(id);
      if (!current) return res.status(404).json({ ok: false, error: 'Ordem não encontrada.' });
      merged = Object.assign({}, current);
      for (const f of PRODUCAO_FIELDS)
        if (Object.prototype.hasOwnProperty.call(body, f)) merged[f] = body[f];
    } else {
      merged = Object.assign({}, body); merged.id = id;
    }
    const updated = await db.updateOp(id, merged, profile);
    if (!updated) return res.status(404).json({ ok: false, error: 'Ordem não encontrada.' });
    res.json({ ok: true, op: updated });
  } catch (e) { sendError(res, e, 'PUT /api/ops/:id falhou'); }
});

app.delete('/api/ops/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (profileOf(req) !== 'planeador')
      return res.status(403).json({ ok: false, error: 'Apenas o perfil planeador pode apagar ordens.' });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const ok = await db.deleteOp(id);
    if (!ok) return res.status(404).json({ ok: false, error: 'Ordem não encontrada.' });
    res.json({ ok: true, deleted: id });
  } catch (e) { sendError(res, e, 'DELETE /api/ops/:id falhou'); }
});

app.get('/api/settings', async (req, res) => {
  if (!requireDb(res)) return;
  try { res.json({ settings: await db.getSettings() }); }
  catch (e) { sendError(res, e, 'GET /api/settings falhou'); }
});

// Produção pode editar turnosPorDia (fechar/alterar dias); planeador tudo.
const PRODUCAO_SETTING_KEYS = ['turnosPorDia', 'turnosDia'];
app.put('/api/settings', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const profile = profileOf(req);
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body))
      return res.status(400).json({ ok: false, error: 'Body inválido.' });
    let payload = body;
    if (profile === 'producao') {
      payload = {};
      for (const k of PRODUCAO_SETTING_KEYS)
        if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k];
      if (Object.keys(payload).length === 0)
        return res.status(403).json({ ok: false, error: 'Produção só pode editar: ' + PRODUCAO_SETTING_KEYS.join(', ') });
    }
    res.json({ ok: true, settings: await db.putSettings(payload) });
  } catch (e) { sendError(res, e, 'PUT /api/settings falhou'); }
});

app.post('/api/admin/wipe', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (profileOf(req) !== 'planeador')
      return res.status(403).json({ ok: false, error: 'Apenas o perfil planeador pode limpar.' });
    res.json({ ok: true, deleted: await db.deleteAllOps('planeador') });
  } catch (e) { sendError(res, e, 'POST /api/admin/wipe falhou'); }
});

app.post('/api/admin/reset', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (profileOf(req) !== 'planeador')
      return res.status(403).json({ ok: false, error: 'Apenas o perfil planeador pode resetar.' });
    res.json({ ok: true, ops: await db.resetOps('planeador') });
  } catch (e) { sendError(res, e, 'POST /api/admin/reset falhou'); }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'planeamento-dsl',
    db: db.isConnected() ? 'connected' : 'demo-mode',
    ts: new Date().toISOString(),
  });
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
  try {
    if (db.isConnected()) {
      await db.initSchema();
      await db.ensureDefaultSettings();
      await db.seedIfEmpty();
      await db.cleanupEmptyPool();
      await db.migrateEscolhaManual();
      await db.migrateTurno2NoLunch();
      await db.migrateEstados();
    } else {
      console.warn('[server] A arrancar em modo demo (sem persistência). Escritas devolvem 503.');
    }
  } catch (e) {
    console.error('[server] Falha ao inicializar BD:', e.message);
  }
  app.listen(PORT, () => console.log(`[planeamento-dsl] A servir na porta ${PORT}`));
})();
