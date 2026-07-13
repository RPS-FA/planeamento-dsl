// ============================================================
// Planeamento DSL — Camada de persistência (Postgres)
// ============================================================
// Driver `pg`. Lê DATABASE_URL do ambiente (Railway injecta-a ao
// adicionar um serviço Postgres). SSL com rejectUnauthorized:false.
//
// Funções expostas:
//   isConnected()             — true se o pool está disponível
//   initSchema()              — executa schema.sql (idempotente)
//   seedIfEmpty()             — insere as ordens de Junho 2026 se a BD estiver vazia
//   listOps()/getOp(id)       — leitura
//   createOp/updateOp/deleteOp
//   getSettings()/putSettings(obj)
//   deleteAllOps()/resetOps()
// ============================================================

const fs = require('fs');
const path = require('path');

let Pool = null;
try { Pool = require('pg').Pool; }
catch (e) { console.warn('[db] driver `pg` não está instalado — modo demo activado.'); }

const DATABASE_URL = process.env.DATABASE_URL || '';
let pool = null;

if (Pool && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[db] erro inesperado no pool Postgres:', err.message));
  console.log('[db] Pool Postgres inicializado.');
} else {
  console.warn('[db] DATABASE_URL ausente — modo demo (sem persistência).');
}

// ============================================================
// Seed — ordens reais de Junho 2026 (extraídas do Excel DSL)
// Lê seed_orders.json (487 ordens). Cada ordem é o payload completo.
// ============================================================
function loadSeed() {
  try {
    const p = path.join(__dirname, 'seed_orders.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[db] seed_orders.json não encontrado/ inválido:', e.message);
    return [];
  }
}
const SEED_OPS = loadSeed();

// ============================================================
// Settings por defeito (DSL)
// ============================================================
const LINHAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const AREAS_ESPECIAIS = ['B', 'EE', 'T']; // Banca, Escolha Eletrónica, Tapete

const DEFAULT_CAPACIDADES = {};
['1','2','3','4','5','6','7','8'].forEach((l) => { DEFAULT_CAPACIDADES[l] = { krH: 17000, turno: 1 }; });
DEFAULT_CAPACIDADES['EM'] = { krH: 2000 }; // Banca

const DEFAULT_MOTIVOS = [
  '4 Canos', 'Canos de trás', 'ACERTO DA QUALIDADE', 'APROVEITAMENTO FRACO EE',
  'APROVEITAMENTO REFUGO', 'BICHO', 'CÁCERES', 'CORREÇÃO DE PROGAMA', 'DEFEITOS',
  'DEFORMADAS', 'FALHA DE ROLHA', 'FENDAS', 'JARDADAS', 'MAL PONÇADAS', 'MAL TOPEJADAS',
  'MANCHA', 'MANCHA VERDURA', 'MARCADAS', 'PAPUDAS', 'PREGO', 'REFUGO TR',
  'SACOS REJEITADOS', 'SUBIR QV', 'TORTAS', 'TRINCADAS', 'TRINCHEIRO', 'VERDURA',
];

const DEFAULT_SETTINGS = {
  // janelas de turno (HH:MM). Turno 1 = 1 turno (dia). Turno 2 = 2 turnos (até noite).
  turnos: {
    1: { ini: '08:00', fim: '17:00', almocoIni: '12:00', almocoFim: '13:00' },
    2: { ini: '17:00', fim: '01:00', jantarIni: '20:30', jantarFim: '21:30' }, // só jantar
    dif: { ini: '08:00', fim: '17:00', almocoIni: '12:00', almocoFim: '13:00', jantarIni: '', jantarFim: '' }, // turno diferenciado
  },
  // dias/linhas com turno diferenciado: { "YYYY-MM-DD": { "1":true, ... } }
  difDia: {},
  // override de turno/fecho por dia "YYYY-MM-DD"
  turnosPorDia: {},
  // nº de turnos (1/2) por dia e linha: { "YYYY-MM-DD": { "1":2, "6":1, ... } }
  turnosDia: {},
  setupMin: 10,          // setup entre ordens (min)
  capacidades: DEFAULT_CAPACIDADES,
  // sábado/domingo: por defeito sábado manhã, domingo fechado
  sabadoIni: '07:00', sabadoFim: '11:00',
  domingoFechado: true,
  // listas validadas de motivos (editáveis nas Configurações)
  motivosDesdobramento: DEFAULT_MOTIVOS,
  motivos2aPassagem: DEFAULT_MOTIVOS,
  motivosParagem: [],
  // calibres autorizados por linha: { "1":["45x240"], ... }. Vazio/ausente = sem restrição.
  calibresPorLinha: {},
};

// ============================================================
// Helpers
// ============================================================
function rowToOp(row) {
  const payload = row.payload || {};
  return Object.assign({}, payload, { id: row.id });
}
function deriveColumns(op) {
  return {
    linha:    op.linha || null,
    week_key: op.weekKey || null,
    sort_idx: (op.sortIdx != null && !isNaN(op.sortIdx)) ? Number(op.sortIdx) : 0,
    dia_idx:  (op.diaIdx  != null && !isNaN(op.diaIdx))  ? Number(op.diaIdx)  : 0,
    turno:    (op.turno   != null && !isNaN(op.turno))   ? Number(op.turno)   : 1,
  };
}
function stripId(op) { const c = Object.assign({}, op); delete c.id; return c; }

// ============================================================
// API pública
// ============================================================
function isConnected() { return pool !== null; }

async function initSchema() {
  if (!pool) return;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(sql);
  console.log('[db] Schema inicializado.');
}

async function ensureDefaultSettings() {
  if (!pool) return;
  const r = await pool.query(`SELECT key FROM settings`);
  const have = new Set(r.rows.map((x) => x.key));
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!have.has(k)) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO NOTHING`,
        [k, JSON.stringify(v)]
      );
    }
  }
}

// Remove ordens vazias do pool (linhas sem DSL/lote/produto/qtd) que vieram
// da extração do Excel. Não toca em ordens com linha atribuída nem em ordens reais.
async function cleanupEmptyPool() {
  if (!pool) return;
  // Vazio = NULL, '', '0' ou erro do Excel (#NAME?, #REF!, #VALUE!, #N/A, #DIV/0!…)
  const r = await pool.query(`
    DELETE FROM ops
     WHERE (linha IS NULL OR linha = '')
       AND (payload->>'dsl' IS NULL OR payload->>'dsl' IN ('', '0') OR payload->>'dsl' LIKE '#%')
       AND (payload->>'lote' IS NULL OR payload->>'lote' IN ('', '0') OR payload->>'lote' LIKE '#%')
       AND (payload->>'produtoEntrada' IS NULL OR payload->>'produtoEntrada' IN ('', '0') OR payload->>'produtoEntrada' LIKE '#%')
       AND COALESCE(payload->>'qtd','0') IN ('', '0', '0.0')
  `);
  if (r.rowCount > 0) console.log(`[db] cleanupEmptyPool: ${r.rowCount} ordens vazias removidas.`);
}

// Reestruturação das linhas: apaga ordens das linhas 9 e EE; converte
// as áreas B (Banca) e T (Tapete) para a linha 'EM' (Escolha Manual),
// guardando a origem em payload.bancaTapete. Idempotente.
async function migrateEscolhaManual() {
  if (!pool) return;
  const del = await pool.query(`DELETE FROM ops WHERE linha IN ('9','EE')`);
  if (del.rowCount) console.log(`[db] migrateEscolhaManual: ${del.rowCount} ordens das linhas 9/EE apagadas.`);
  const upd = await pool.query(`
    UPDATE ops
       SET payload = jsonb_set(jsonb_set(payload, '{bancaTapete}', payload->'linha'), '{linha}', '"EM"'::jsonb),
           linha = 'EM'
     WHERE linha IN ('B','T')`);
  if (upd.rowCount) console.log(`[db] migrateEscolhaManual: ${upd.rowCount} ordens B/T -> Escolha Manual.`);
  const capR = await pool.query(`SELECT value FROM settings WHERE key='capacidades'`);
  if (capR.rows.length) {
    const caps = capR.rows[0].value || {};
    let chg = false;
    const emBase = (caps.EM && caps.EM.krH) || 2000;
    if (!caps.EM_B) { caps.EM_B = { krH: emBase }; chg = true; }
    if (!caps.EM_T) { caps.EM_T = { krH: emBase }; chg = true; }
    if (chg) {
      await pool.query(`UPDATE settings SET value=$1, updated_at=NOW() WHERE key='capacidades'`, [JSON.stringify(caps)]);
      console.log('[db] migrateEscolhaManual: capacidades EM_B/EM_T adicionadas.');
    }
  }
}

// Turno 2 (noite) deixa de ter almoço — só jantar. Remove almoço do turno 2
// nas settings já existentes. Idempotente.
async function migrateTurno2NoLunch() {
  if (!pool) return;
  const r = await pool.query(`SELECT value FROM settings WHERE key='turnos'`);
  if (!r.rows.length) return;
  const t = r.rows[0].value || {};
  if (t['2'] && (t['2'].almocoIni !== undefined || t['2'].almocoFim !== undefined)) {
    delete t['2'].almocoIni; delete t['2'].almocoFim;
    await pool.query(`UPDATE settings SET value=$1, updated_at=NOW() WHERE key='turnos'`, [JSON.stringify(t)]);
    console.log('[db] migrateTurno2NoLunch: almoço removido do turno 2.');
  }
}

// Remapeia estados antigos para o novo conjunto. Idempotente.
async function migrateEstados() {
  if (!pool) return;
  const map = {
    'Por planear': 'Aberto',
    'Planeada': 'Aberto',
    'Liberado': 'Aberto',
    'Transita Dia anterior': 'Aberto',
    'Em Processo - Desdobrar': 'Em Processo',
    'Terminada': 'Terminado em Linha',
    'Terminado': 'Terminado em Linha',
    'Concluída': 'Concluído Planeamento',
  };
  let total = 0;
  for (const [oldV, newV] of Object.entries(map)) {
    const r = await pool.query(
      `UPDATE ops SET payload = jsonb_set(payload, '{estado}', to_jsonb($2::text)),
              updated_at = NOW(), updated_by = 'migration-estados'
        WHERE payload->>'estado' = $1`, [oldV, newV]);
    total += r.rowCount;
  }
  if (total) console.log(`[db] migrateEstados: ${total} ordens remapeadas.`);
}

async function seedIfEmpty() {
  if (!pool) return;
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM ops');
  if (r.rows[0].n > 0) {
    console.log(`[db] Tabela ops já tem ${r.rows[0].n} ordens — sem seed.`);
    return;
  }
  console.log(`[db] Tabela ops vazia — a inserir ${SEED_OPS.length} ordens iniciais...`);
  for (const op of SEED_OPS) {
    const d = deriveColumns(op);
    await pool.query(
      `INSERT INTO ops (op, payload, linha, week_key, sort_idx, dia_idx, turno, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [String(op.op || ''), JSON.stringify(op), d.linha, d.week_key, d.sort_idx, d.dia_idx, d.turno, 'seed']
    );
  }
  console.log(`[db] Seed concluído (${SEED_OPS.length} ordens).`);
}

async function listOps() {
  if (!pool) throw new Error('Sem ligação à BD.');
  const r = await pool.query(`SELECT id, payload FROM ops ORDER BY id ASC`);
  return r.rows.map(rowToOp);
}
async function getOp(id) {
  if (!pool) throw new Error('Sem ligação à BD.');
  const r = await pool.query(`SELECT id, payload FROM ops WHERE id = $1`, [id]);
  return r.rows.length ? rowToOp(r.rows[0]) : null;
}
async function createOp(op, by) {
  if (!pool) throw new Error('Sem ligação à BD.');
  const clean = stripId(op); const d = deriveColumns(clean);
  const r = await pool.query(
    `INSERT INTO ops (op, payload, linha, week_key, sort_idx, dia_idx, turno, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, payload`,
    [String(clean.op || ''), JSON.stringify(clean), d.linha, d.week_key, d.sort_idx, d.dia_idx, d.turno, by || 'unknown']
  );
  return rowToOp(r.rows[0]);
}
async function updateOp(id, op, by) {
  if (!pool) throw new Error('Sem ligação à BD.');
  const clean = stripId(op); const d = deriveColumns(clean);
  const r = await pool.query(
    `UPDATE ops SET op=$1, payload=$2, linha=$3, week_key=$4, sort_idx=$5, dia_idx=$6, turno=$7,
            updated_at=NOW(), updated_by=$8 WHERE id=$9 RETURNING id, payload`,
    [String(clean.op || ''), JSON.stringify(clean), d.linha, d.week_key, d.sort_idx, d.dia_idx, d.turno, by || 'unknown', id]
  );
  return r.rows.length ? rowToOp(r.rows[0]) : null;
}
async function deleteOp(id) {
  if (!pool) throw new Error('Sem ligação à BD.');
  const r = await pool.query(`DELETE FROM ops WHERE id=$1 RETURNING id`, [id]);
  return r.rows.length > 0;
}
async function getSettings() {
  if (!pool) throw new Error('Sem ligação à BD.');
  const r = await pool.query(`SELECT key, value FROM settings`);
  const out = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}
async function putSettings(settings) {
  if (!pool) throw new Error('Sem ligação à BD.');
  if (!settings || typeof settings !== 'object') throw new Error('Settings inválidas.');
  for (const [k, v] of Object.entries(settings)) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [k, JSON.stringify(v)]
    );
  }
  return getSettings();
}
async function deleteAllOps(by) {
  if (!pool) throw new Error('Sem ligação à BD.');
  const r = await pool.query('DELETE FROM ops');
  console.log(`[db] deleteAllOps: ${r.rowCount} ordens apagadas por ${by || 'unknown'}`);
  return r.rowCount;
}
async function resetOps(by) {
  if (!pool) throw new Error('Sem ligação à BD.');
  await pool.query('DELETE FROM ops');
  for (const op of SEED_OPS) {
    const d = deriveColumns(op);
    await pool.query(
      `INSERT INTO ops (op, payload, linha, week_key, sort_idx, dia_idx, turno, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [String(op.op || ''), JSON.stringify(op), d.linha, d.week_key, d.sort_idx, d.dia_idx, d.turno, by || 'reset']
    );
  }
  return listOps();
}

module.exports = {
  isConnected, initSchema, ensureDefaultSettings, seedIfEmpty, cleanupEmptyPool, migrateEscolhaManual, migrateTurno2NoLunch, migrateEstados,
  listOps, getOp, createOp, updateOp, deleteOp,
  getSettings, putSettings, deleteAllOps, resetOps,
  SEED_OPS, DEFAULT_SETTINGS,
};
