-- AEGIS / Office3D — pgvector схема Архива
-- EMBED_DIM должен совпадать с моделью эмбеддингов (по умолчанию 1024 для
-- intfloat/multilingual-e5-large). При смене модели поменяйте vector(N) и EMBED_DIM.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS archive_units (
    id          text PRIMARY KEY,          -- напр. "book:black-hat-python:reversing-malware"
    unit_type   text NOT NULL,             -- book | tool | ctf_lab | framework | dataset | certification | ...
    name        text NOT NULL,
    domain      text,                       -- один из 28 доменов (NULL для сертификатов/процессов)
    level       int,                        -- 1..5 (NULL где неприменимо)
    meta        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- author/org/kind/category/desc/freq/boundary...
    embed_text  text NOT NULL,              -- текст, по которому построен вектор
    embedding   vector(1024),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_units_domain_idx ON archive_units (domain);
CREATE INDEX IF NOT EXISTS archive_units_type_idx   ON archive_units (unit_type);
CREATE INDEX IF NOT EXISTS archive_units_level_idx  ON archive_units (level);

-- ANN-индекс для косинусного поиска (HNSW). Требует pgvector >= 0.5.
CREATE INDEX IF NOT EXISTS archive_units_embedding_idx
    ON archive_units USING hnsw (embedding vector_cosine_ops);

-- Пример семантического поиска (вектор запроса подставляет приложение):
--   SELECT id, name, domain, level
--   FROM archive_units
--   WHERE domain = 'offensive-web'
--   ORDER BY embedding <=> :query_vec
--   LIMIT 10;
