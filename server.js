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
let cron = null, ExcelJS = null;
try { cron = require('node-cron'); } catch (e) { console.warn('[backup] node-cron indisponível:', e.message); }
try { ExcelJS = require('exceljs'); } catch (e) { console.warn('[backup] exceljs indisponível:', e.message); }

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
  'hInicioR', 'hFimR', 'dataInicioR', 'dataFimR', 'horaFecho', 'dataFimTurno', 'terminou',
  'tempoAtraso', 'temposPerdidosAvaria', 'faltas',
  'qtdReal', 'qtdSeguinte',
  'motivo2aPassagem', 'motivoDesdobramento', 'motivoParagem', 'causaRaiz2a', 'qtdDesdobramento', 'desdobrar', 'qtdPrevistaDesd',
  'qvUpDsl', 'qvDsl', 'qvDownDsl', 'qv1Dsl',
  'colaborador', 'obsProd', 'analisado',
];

function profileOf(req) {
  const h = (req.get('X-Profile') || '').toLowerCase();
  // 'planeador' = total; 'supervisao' = configs+execução; resto = 'producao' (execução)
  if (h === 'planeador') return 'planeador';
  if (h === 'supervisao') return 'supervisao';
  return 'producao';
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
    if (profile !== 'planeador') {
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
const PRODUCAO_SETTING_KEYS = ['turnosPorDia', 'turnosDia', 'difDia'];
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

// ============================================================
// Backups automáticos (JSON 30d + Excel 24h) — cron 08–18h/2h Lisboa
// ============================================================
const BACKUP_JSON_KEY = 'planeamento_dsl';
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_XLSX_RETENTION_HOURS = 24;
const BK_BOARDS = {
  eedsl: { label: 'EE - DSL', lines: ['1', '2', '3', '6', '7', '8'] },
  dsl:   { label: 'DSL', lines: ['4', '5'] },
  em:    { label: 'Banca / EE', lines: ['EM', 'EEB'] },
};
const BK_LINE_LABELS = { '1':'EE - DSL 1','2':'EE - DSL 2','3':'EE - DSL 3','4':'DSL - 4','5':'DSL - 5','6':'EE - DSL 6','7':'EE - DSL 7','8':'EE - DSL 8','EM':'Banca','EEB':'EE' };
const bkLineLabel = (l) => BK_LINE_LABELS[l] || l || '';
const bkSafeSheet = (s) => String(s || '').replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
const bkU = (v) => Math.round((+v || 0) * 1000);
const BK_COLS = [
  { header: 'OP DSL', key: 'dsl', width: 14 }, { header: 'PO/Pedido', key: 'po', width: 16 },
  { header: 'Linha', key: 'linhaLbl', width: 12 }, { header: 'Semana', key: 'weekKey', width: 12 },
  { header: 'DiaIdx', key: 'diaIdx', width: 7 }, { header: 'SortIdx', key: 'sortIdx', width: 7 },
  { header: 'Cliente', key: 'cliente', width: 14 }, { header: 'Produto', key: 'produtoEntrada', width: 34 },
  { header: 'Calibre', key: 'calibre', width: 10 }, { header: 'QV', key: 'qualidades', width: 8 },
  { header: 'Lote', key: 'lote', width: 20 }, { header: 'Qtd (un)', key: 'qtdU', width: 11 },
  { header: 'Estado', key: 'estado', width: 18 }, { header: 'Urgente', key: 'urg', width: 8 },
  { header: 'Analisado', key: 'anal', width: 9 }, { header: 'Dividida', key: 'div', width: 8 },
  { header: 'Unidade', key: 'unidade', width: 10 }, { header: 'Início real', key: 'hInicioR', width: 10 },
  { header: 'Fim real', key: 'hFimR', width: 10 }, { header: 'Data início real', key: 'dataInicioR', width: 14 },
  { header: 'Data fim real', key: 'dataFimR', width: 14 }, { header: 'Atraso', key: 'tempoAtraso', width: 9 },
  { header: 'Qtd prev desd', key: 'qpdU', width: 12 }, { header: 'Qtd real desd', key: 'qrdU', width: 12 },
  { header: 'Motivo Desd', key: 'motivoDesdobramento', width: 18 }, { header: 'Motivo Paragem', key: 'motivoParagem', width: 18 },
  { header: 'Obs', key: 'obs', width: 24 }, { header: 'Obs Prod/Sup', key: 'obsProd', width: 24 },
];
function bkRow(o) {
  return {
    dsl: o.dsl || '', po: o.po || '', linhaLbl: bkLineLabel(o.linha), weekKey: o.weekKey || '', diaIdx: o.diaIdx || 0, sortIdx: o.sortIdx || 0,
    cliente: o.cliente || '', produtoEntrada: o.produtoEntrada || '', calibre: o.calibre || '', qualidades: o.qualidades || '', lote: o.lote || '',
    qtdU: bkU(o.qtd), estado: o.estado || '', urg: o.urgente ? 'Sim' : '', anal: o.analisado ? 'Sim' : 'Não', div: o.dividido ? 'Sim' : '', unidade: o.unidade || '',
    hInicioR: o.hInicioR || '', hFimR: o.hFimR || '', dataInicioR: o.dataInicioR || '', dataFimR: o.dataFimR || '', tempoAtraso: o.tempoAtraso || '',
    qpdU: bkU(o.qtdPrevistaDesd), qrdU: bkU(o.qtdDesdobramento), motivoDesdobramento: o.motivoDesdobramento || '', motivoParagem: o.motivoParagem || '',
    obs: o.obs || '', obsProd: o.obsProd || '',
  };
}
async function generateBackupXlsx() {
  if (!ExcelJS) throw new Error('exceljs indisponível');
  const ops = await db.listOps();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Planeamento DSL — Backup'; wb.created = new Date();
  const addSheet = (name, rows) => {
    const ws = wb.addWorksheet(bkSafeSheet(name));
    ws.columns = BK_COLS;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    rows.slice().sort((a, b) => (a.weekKey || '').localeCompare(b.weekKey || '') || (a.diaIdx || 0) - (b.diaIdx || 0) || (a.sortIdx || 0) - (b.sortIdx || 0))
      .forEach((o) => ws.addRow(bkRow(o)));
  };
  for (const k of Object.keys(BK_BOARDS)) addSheet(BK_BOARDS[k].label, ops.filter((o) => BK_BOARDS[k].lines.includes(o.linha)));
  addSheet('Buffer', ops.filter((o) => !o.linha && o.buffer));
  addSheet('Kanban', ops.filter((o) => !o.linha && !o.buffer));
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
async function runBackupSnapshot(triggeredBy = 'auto', note = null) {
  const results = [];
  try {
    const [ops, settings] = await Promise.all([db.listOps(), db.getSettings()]);
    await db.insertJsonBackup(BACKUP_JSON_KEY, { ops, settings, ts: new Date().toISOString() }, triggeredBy, note);
    results.push({ key: 'json', ok: true, count: ops.length });
  } catch (e) { console.error('[backup] JSON falhou:', e.message); results.push({ key: 'json', ok: false, reason: e.message }); }
  try { const n = await db.pruneJsonBackups(BACKUP_RETENTION_DAYS); if (n) console.log(`[backup] retenção JSON: ${n} apagados`); } catch (e) { console.warn('[backup] retenção JSON:', e.message); }
  try {
    const buf = await generateBackupXlsx();
    await db.insertXlsxBackup(buf, triggeredBy);
    const n = await db.pruneXlsxBackups(BACKUP_XLSX_RETENTION_HOURS); if (n) console.log(`[backup] retenção Excel: ${n} apagados`);
    results.push({ key: 'xlsx', ok: true, size: buf.length });
  } catch (e) { console.error('[backup] Excel falhou:', e.message); results.push({ key: 'xlsx', ok: false, reason: e.message }); }
  console.log(`[backup] snapshot ${triggeredBy} @ ${new Date().toISOString()}:`, results);
  return results;
}
function requirePlaneador(req, res) {
  if (profileOf(req) !== 'planeador') { res.status(403).json({ ok: false, error: 'Apenas o Planeador acede aos backups.' }); return false; }
  return true;
}
// ⚠ rotas específicas antes de /:id
app.get('/api/backups/xlsx', async (req, res) => {
  if (!requireDb(res) || !requirePlaneador(req, res)) return;
  try { res.json({ ok: true, backups: await db.listXlsxBackups(req.query.limit) }); } catch (e) { sendError(res, e, 'GET /api/backups/xlsx'); }
});
app.get('/api/backups/xlsx/:id(\\d+)', async (req, res) => {
  if (!requireDb(res) || !requirePlaneador(req, res)) return;
  try {
    const row = await db.getXlsxBackup(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ ok: false, error: 'não encontrado' });
    const stamp = new Date(row.snapshot_at).toISOString().replace(/[-:]/g, '').slice(0, 13);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="planeamento_dsl_${stamp}.xlsx"`);
    res.send(row.xlsx_data);
  } catch (e) { sendError(res, e, 'GET xlsx download'); }
});
app.post('/api/backups/trigger', async (req, res) => {
  if (!requireDb(res) || !requirePlaneador(req, res)) return;
  try { res.json({ ok: true, results: await runBackupSnapshot('manual', (req.body && req.body.note) || null) }); } catch (e) { sendError(res, e, 'POST /api/backups/trigger'); }
});
app.get('/api/backups', async (req, res) => {
  if (!requireDb(res) || !requirePlaneador(req, res)) return;
  try { res.json({ ok: true, backups: await db.listJsonBackups(req.query.limit) }); } catch (e) { sendError(res, e, 'GET /api/backups'); }
});
app.get('/api/backups/:id(\\d+)', async (req, res) => {
  if (!requireDb(res) || !requirePlaneador(req, res)) return;
  try {
    const row = await db.getJsonBackup(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ ok: false, error: 'não encontrado' });
    res.json({ ok: true, ...row });
  } catch (e) { sendError(res, e, 'GET /api/backups/:id'); }
});
function scheduleBackupCron() {
  if (!cron) { console.warn('[cron/backup] node-cron indisponível — não agendado'); return; }
  try {
    cron.schedule('0 8,10,12,14,16,18 * * *', () => { runBackupSnapshot('auto').catch((e) => console.error('[cron/backup]', e.message)); }, { timezone: 'Europe/Lisbon' });
    console.log('[cron/backup] agendado 0 8,10,12,14,16,18 * * * Europe/Lisbon');
  } catch (e) { console.error('[cron/backup] falhou ao agendar:', e.message); }
}

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
      scheduleBackupCron();
    } else {
      console.warn('[server] A arrancar em modo demo (sem persistência). Escritas devolvem 503.');
    }
  } catch (e) {
    console.error('[server] Falha ao inicializar BD:', e.message);
  }
  app.listen(PORT, () => console.log(`[planeamento-dsl] A servir na porta ${PORT}`));
})();
