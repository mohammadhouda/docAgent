import { pool } from './client.js';

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // pgvector extension — must exist before any vector column is created
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id               UUID        PRIMARY KEY,
        file_name        TEXT        NOT NULL,
        file_path        TEXT        NOT NULL,
        file_type        TEXT        NOT NULL,
        total_pages      INTEGER,
        total_sheets     INTEGER,
        ingested_at      TIMESTAMPTZ NOT NULL,
        meta_type        TEXT,
        meta_project_name TEXT,
        meta_currency    TEXT,
        meta_parties     TEXT[],
        meta_summary     TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id           TEXT        PRIMARY KEY,
        document_id  UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        content      TEXT        NOT NULL,
        chunk_index  INTEGER     NOT NULL,
        page_number  INTEGER,
        sheet_name   TEXT,
        row_start    INTEGER,
        row_end      INTEGER,
        embedding    vector(1536)
      )
    `);

    // HNSW index for fast cosine-similarity search.
    // Unlike IVFFlat, HNSW works with any amount of data including zero rows.
    await client.query(`
      CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
      ON chunks USING hnsw (embedding vector_cosine_ops)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         UUID        PRIMARY KEY,
        title      TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id              UUID        PRIMARY KEY,
        conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT        NOT NULL,
        content         TEXT,
        answer          JSONB,
        sources         JSONB,
        tools_used      TEXT[],
        created_at      TIMESTAMPTZ NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS extracted_values (
        id            UUID             PRIMARY KEY,
        document_id   UUID             NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        type          TEXT             NOT NULL,
        label         TEXT             NOT NULL,
        raw_value     TEXT             NOT NULL,
        numeric_value DOUBLE PRECISION,
        date_value    DATE,
        unit          TEXT,
        context       TEXT             NOT NULL,
        sheet_name    TEXT,
        page_number   INTEGER,
        row_number    INTEGER
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS extracted_values_document_type
      ON extracted_values (document_id, type)
    `);

    // Add chunk classification columns (safe to run on existing DBs)
    await client.query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_type    TEXT`);
    await client.query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_title TEXT`);

    console.log('[DB] Migrations complete');
  } finally {
    client.release();
  }
}
