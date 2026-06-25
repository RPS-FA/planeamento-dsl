-- ============================================================
-- Planeamento DSL — Schema Postgres
-- Executado automaticamente no arranque por db.initSchema().
-- Idempotente: todos os CREATE têm IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS ops (
  id           SERIAL PRIMARY KEY,
  op           TEXT NOT NULL,        -- nº DSL / lote (identificador legível)
  payload      JSONB NOT NULL,       -- toda a ordem serializada (todos os campos)
  linha        TEXT,                 -- duplicado fora do JSON para queries rápidas (1..10, B, EE, T)
  week_key     TEXT,
  sort_idx     REAL DEFAULT 0,
  dia_idx      SMALLINT DEFAULT 0,
  turno        SMALLINT DEFAULT 1,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS ops_linha_week ON ops(linha, week_key);

CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
