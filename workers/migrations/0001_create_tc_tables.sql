-- T&C — histórico de análises por tomador.
-- Ver SPEC.md secao 13 e workers/deepseek-memory-worker.js
-- (handleCreateTcAnalise / handleListTcAnalises / handleGetTcAnalise / handleDeleteTcAnalise).

CREATE TABLE IF NOT EXISTS tc_tomadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cnpj TEXT NOT NULL UNIQUE,
  nome TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Um snapshot por análise: `rows_json` guarda o array `rows[]` inteiro (SPEC.md
-- secao 4.3), tal como veio do parseWorkbook/buildManualParsedData. Sem tabela
-- filha por seguradora/modalidade por enquanto — isso so vale a pena quando
-- existir necessidade real de comparar um numero especifico ao longo do tempo.
CREATE TABLE IF NOT EXISTS tc_analises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tomador_id INTEGER NOT NULL REFERENCES tc_tomadores(id),
  cnpj TEXT NOT NULL,
  tomador TEXT,
  origem TEXT NOT NULL DEFAULT 'upload', -- 'upload' | 'manual'
  rows_json TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tc_analises_cnpj ON tc_analises (cnpj);
CREATE INDEX IF NOT EXISTS idx_tc_analises_criado_em ON tc_analises (criado_em);
