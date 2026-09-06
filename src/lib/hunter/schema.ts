// ============================================================
// AI Winner Radar — ESQUEMA (migración 19).
//
// Reglas del repo que se cumplen aquí:
//   · Función propia parametrizada por conexión (no inline en build()), para
//     poder testearla contra cualquier DB sin pasar por el singleton.
//   · Idempotente: `CREATE TABLE/INDEX IF NOT EXISTS`. Correrla tres veces
//     seguidas no puede fallar ni duplicar nada.
//   · ADITIVA: no toca ni una columna de `orders`, `conversations`,
//     `messages` ni de ninguna tabla existente. Todo vive en tablas nuevas
//     con prefijo `hunter_`, así que una versión anterior del código las
//     ignora y el rollback de código sigue siendo seguro.
//
// Por qué SQLite y no otra cosa: el volumen es de decenas de búsquedas y
// miles de anuncios, no millones. Meter un motor nuevo aquí añadiría una
// pieza que puede caerse en el NAS a cambio de un rendimiento que nadie
// necesita.
// ============================================================

import type Database from "better-sqlite3";

export function migrateHunter(db: Database.Database): void {
  db.exec(`
    -- Una ejecución de búsqueda. Guarda el prompt y los filtros con los que
    -- se lanzó: sin eso, un resultado de hace dos semanas no se puede
    -- interpretar ni reproducir.
    CREATE TABLE IF NOT EXISTS hunter_searches (
      id TEXT PRIMARY KEY,
      prompt TEXT,
      filters_json TEXT NOT NULL,
      queries_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'queued',
      progress_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      provider_calls INTEGER NOT NULL DEFAULT 0,
      credits_spent REAL,
      fixture_mode INTEGER NOT NULL DEFAULT 0 CHECK(fixture_mode IN (0,1)),
      created_by TEXT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_searches_state ON hunter_searches(state, started_at DESC);

    -- Anuncios normalizados. Son EVIDENCIA de un producto, no la entidad
    -- principal. 'fingerprint' deduplica entre proveedores.
    CREATE TABLE IF NOT EXISTS hunter_ads (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      platform TEXT,
      advertiser_name TEXT,
      advertiser_external_id TEXT,
      product_name_raw TEXT,
      ad_copy TEXT,
      format TEXT,
      countries_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER,
      last_seen_at INTEGER,
      active INTEGER,
      active_days INTEGER,
      landing_url TEXT,
      preview_url TEXT,
      image_url TEXT,
      creative_ids_json TEXT NOT NULL DEFAULT '[]',
      price_amount REAL,
      price_currency TEXT,
      fingerprint TEXT NOT NULL,
      first_ingested_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_ads_fingerprint ON hunter_ads(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_hunter_ads_advertiser ON hunter_ads(advertiser_name);

    -- Productos (clusters de anuncios). LA entidad del radar.
    CREATE TABLE IF NOT EXISTS hunter_products (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      hero_image_url TEXT,
      observed_price_min REAL,
      observed_price_max REAL,
      supplier_cost_min REAL,
      supplier_cost_max REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      status TEXT NOT NULL DEFAULT 'new',
      source_confidence REAL NOT NULL DEFAULT 0,
      cluster_confidence REAL NOT NULL DEFAULT 0,
      signals_json TEXT NOT NULL DEFAULT '{}',
      scores_json TEXT NOT NULL DEFAULT '{}',
      features_json TEXT NOT NULL DEFAULT '[]',
      economics_json TEXT,
      summary_json TEXT,
      -- Ediciones a mano de Pedro. Si toca el nombre o el coste, su valor
      -- MANDA sobre lo que traiga el proveedor en el siguiente refresco.
      manual_overrides_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_products_status ON hunter_products(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS hunter_product_ads (
      product_id TEXT NOT NULL REFERENCES hunter_products(id) ON DELETE CASCADE,
      ad_id TEXT NOT NULL REFERENCES hunter_ads(id) ON DELETE CASCADE,
      cluster_pass TEXT,
      similarity REAL,
      PRIMARY KEY (product_id, ad_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_product_ads_ad ON hunter_product_ads(ad_id);

    CREATE TABLE IF NOT EXISTS hunter_search_products (
      search_id TEXT NOT NULL REFERENCES hunter_searches(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES hunter_products(id) ON DELETE CASCADE,
      PRIMARY KEY (search_id, product_id)
    );

    -- Fotos periódicas. JAMÁS se sobreescriben métricas históricas: sin
    -- histórico no hay momentum, y un momentum inventado es peor que ninguno.
    CREATE TABLE IF NOT EXISTS hunter_product_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES hunter_products(id) ON DELETE CASCADE,
      taken_at INTEGER NOT NULL DEFAULT (unixepoch()),
      signals_json TEXT NOT NULL,
      scores_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_snapshots_product ON hunter_product_snapshots(product_id, taken_at DESC);

    -- De qué proveedor vino cada trozo de un producto.
    CREATE TABLE IF NOT EXISTS hunter_product_sources (
      product_id TEXT NOT NULL REFERENCES hunter_products(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_ref TEXT,
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (product_id, provider, external_ref)
    );

    -- Decisiones de Pedro. Es el dataset de aprendizaje del futuro: se guarda
    -- la foto de las señales EN EL MOMENTO de decidir, porque juzgar una
    -- decisión con datos posteriores no enseña nada.
    CREATE TABLE IF NOT EXISTS hunter_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES hunter_products(id) ON DELETE CASCADE,
      search_id TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      note TEXT,
      signals_at_decision_json TEXT,
      scores_at_decision_json TEXT,
      decided_by TEXT,
      decided_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_decisions_product ON hunter_decisions(product_id, decided_at DESC);

    CREATE TABLE IF NOT EXISTS hunter_watchlist (
      product_id TEXT PRIMARY KEY REFERENCES hunter_products(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_checked_at INTEGER,
      notes TEXT
    );

    -- Alertas internas del panel. Nada sale por WhatsApp ni correo desde aquí.
    CREATE TABLE IF NOT EXISTS hunter_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES hunter_products(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      read_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_alerts_unread ON hunter_alerts(read_at, created_at DESC);

    -- Cada llamada a un proveedor: para poder responder "¿por qué se han
    -- gastado 300 créditos hoy?" con datos y no con suposiciones.
    CREATE TABLE IF NOT EXISTS hunter_provider_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id TEXT,
      provider TEXT NOT NULL,
      capability TEXT,
      ok INTEGER NOT NULL DEFAULT 0 CHECK(ok IN (0,1)),
      http_status INTEGER,
      error TEXT,
      calls INTEGER NOT NULL DEFAULT 1,
      credits REAL,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_provider_runs_day ON hunter_provider_runs(provider, created_at DESC);

    -- Caché de respuestas: no se gastan créditos dos veces por la misma
    -- pregunta dentro de su ventana de frescura.
    CREATE TABLE IF NOT EXISTS hunter_cache (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hunter_cache_expiry ON hunter_cache(expires_at);

    CREATE TABLE IF NOT EXISTS hunter_presets (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
