// ════════════════════════════════════════════════════════════════════════════
// row-shapes.js - Single source of truth for the cron's Sheets row shapes
//
// PR 8.3 column-coupling fix. processAccount in index.js (the writer) and
// buildPGRowArrays in pg-dry-run.mjs (the reader) both consume the
// `make*Row` / `read*Row` helpers from this module. A column rename or
// reorder requires touching the *_COLS array in one place; both consumers
// automatically follow. No more lying-comment failure mode where a stale
// column-index reference silently produces wrong data on the reader side.
//
// CONSTRUCTION
//   For each row shape, the *_COLS array declares the column order.
//   make*Row(values) returns CATALOG_COLS.map((c) => values[c]). The
//   result is byte-identical to the array literal it replaces, AS LONG AS
//   the values object carries a key for every column in the order array
//   (undefined leaves a hole that surfaces as "undefined" in Sheets, a
//   visible bug signal).
//
//   read*Row(row) is the inverse: returns a named-field object built by
//   walking the *_COLS array.
//
// SCOPE
//   This module covers the FOUR write-side row shapes processAccount
//   builds and pushes to Sheets:
//     - item_catalog   (17 cols)
//     - item_aliases   (8 cols)
//     - price_history  (7 cols)
//     - review_queue   (14 cols)
//
//   It does NOT cover the read-side parsing of existing Sheets rows
//   (processAccount's catalog/aliases/priceRows reads at the top of the
//   account loop, plus merge_history and overcount_suspect_reextract
//   queue reads). Those read sites have their own bare-index coupling
//   today, flagged as a separate follow-up - same risk class but
//   independent boundary.
//
// EXTENSION
//   If a column moves: edit the *_COLS array. processAccount and
//   pg-dry-run.mjs automatically follow because they reference fields by
//   name, not position. If a column is added: append to *_COLS and add
//   the new field to every make*Row call site.
// ════════════════════════════════════════════════════════════════════════════

// ── 1. item_catalog (17 cols) ──
// Column order as written by processAccount today (verified against
// commits prior to PR 8.3). Each name describes the value at that
// position; the value semantics live in the schema docs (inv-1).
const CATALOG_COLS = Object.freeze([
  "itemId",            // 0  A  - cron-generated 'item_<uid>'
  "account",           // 1  B  - canonical short-form account key
  "name",              // 2  C  - canonical item name (post-AI normalization)
  "category",          // 3  D  - one of 5 GL strings (Food / Packaging / ...)
  "unit",              // 4  E  - normalized unit token
  "storage",           // 5  F  - AI-suggested storage keyword (cooler/freezer/dry/...)
  "vendor",            // 6  G  - vendor display name (PG resolves to vendor_id)
  "price",             // 7  H  - last_price written into legacy cache col
  "invoiceDate",       // 8  I  - last_price_date
  "vendor2",           // 9  J  - last_price_vendor (legacy duplicate of vendor)
  "priceAtLastCount",  // 10 K  - dropped in PG (D5); always "" today
  "active",            // 11 L  - legacy "TRUE"/"FALSE"; PG enum is 'active'/'archived'/'excluded'
  "linkedToInvoice",   // 12 M  - "TRUE" for cron-created
  "isVariety",         // 13 N  - "TRUE"/"FALSE" string
  "createdBy",         // 14 O  - "ai_cron"
  "createdAt",         // 15 P  - ISO timestamp
  "updatedAt",         // 16 Q  - ISO timestamp (PG D7 separates; pre-PR-8.3 dual-meaning)
]);

// ── 2. item_aliases (8 cols) ──
const ALIAS_COLS = Object.freeze([
  "aliasId",     // 0  A  - cron-generated 'alias_<uid>' (PG: drop; UUID auto)
  "aliasText",   // 1  B  - raw alias as Claude saw it (PG: alias_text)
  "itemId",     // 2  C  - parent item_id
  "vendor",     // 3  D  - vendor display (PG: vendor_id, nullable)
  "confidence", // 4  E  - 0..100
  "learnedBy",  // 5  F  - "ai_cron" or "ai_cron_batch" (TEXT, not enum)
  "learnedAt",  // 6  G  - ISO timestamp
  "source",     // 7  H  - "ai_cron" (PG enum inventory_alias_source)
]);

// ── 3. price_history (7 cols) ──
const PRICE_COLS = Object.freeze([
  "itemId",      // 0  A  - item_id
  "account",     // 1  B  - canonical account
  "vendor",      // 2  C  - vendor display (PG: vendor_id, NOT NULL FK)
  "price",       // 3  D  - normalized or unit price
  "invoiceDate", // 4  E  - PG: effective_date DATE
  "invoiceUuid", // 5  F  - PG: dual-write to invoice_id (UUID FK) + source_or_invoice_id (TEXT dedup key)
  "recordedAt",  // 6  G  - ISO timestamp
]);

// ── 4. review_queue (14 cols) ──
const QUEUE_COLS = Object.freeze([
  "queueId",            // 0  A  - cron-generated 'q_<uid>' (PG: drop; UUID auto)
  "lineItemText",       // 1  B  - the line description that triggered review
  "vendor",             // 2  C  - vendor display (PG: TEXT, nullable)
  "invoiceUuid",        // 3  D  - PG: invoice_id UUID FK
  "invoiceDate",        // 4  E  - PG: invoice_date DATE
  "account",            // 5  F  - canonical account
  "suggestedMatchId",   // 6  G  - PG: item_id + suggested_match_id
  "suggestedMatchName", // 7  H  - PG: suggested_match_name (NULL when empty)
  "confidence",         // 8  I  - 0..100
  "status",             // 9  J  - "pending" / "accepted" / "rejected" (PG enum)
  "reserved10",         // 10 K  - empty placeholder
  "reserved11",         // 11 L  - empty placeholder
  "reserved12",         // 12 M  - empty placeholder
  "reason",             // 13 N  - PG enum review_queue_reason
]);

// ── Builders (writer side - processAccount uses these) ──

function makeRow(cols, values) {
  return cols.map((c) => values[c]);
}

function makeCatalogRow(values) { return makeRow(CATALOG_COLS, values); }
function makeAliasRow(values)   { return makeRow(ALIAS_COLS,   values); }
function makePriceRow(values)   { return makeRow(PRICE_COLS,   values); }
function makeQueueRow(values)   { return makeRow(QUEUE_COLS,   values); }

// ── Readers (reader side - pg-dry-run.mjs uses these) ──

function readRow(cols, row) {
  const out = {};
  for (let i = 0; i < cols.length; i++) out[cols[i]] = row[i];
  return out;
}

function readCatalogRow(row) { return readRow(CATALOG_COLS, row); }
function readAliasRow(row)   { return readRow(ALIAS_COLS,   row); }
function readPriceRow(row)   { return readRow(PRICE_COLS,   row); }
function readQueueRow(row)   { return readRow(QUEUE_COLS,   row); }

module.exports = {
  CATALOG_COLS, ALIAS_COLS, PRICE_COLS, QUEUE_COLS,
  makeCatalogRow, makeAliasRow, makePriceRow, makeQueueRow,
  readCatalogRow, readAliasRow, readPriceRow, readQueueRow,
};
