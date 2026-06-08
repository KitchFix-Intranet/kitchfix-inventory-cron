// ════════════════════════════════════════════════════════════════════════════
// pg-dry-run.mjs - PG dry-run helpers for the inventory cron (PR 8.3)
//
// READ-ONLY PG ACCESS + ROW TRANSFORM PIPELINE. Writes NOTHING to PG.
// Invoked from index.js when CRON_USE_POSTGRES === "dry-run". The cron's
// existing Sheets writes run unchanged; this module computes "what PG
// would receive" and posts a digest so we can validate transforms over a
// dual-write window before flipping to "dual-write" or "pg-only" modes.
//
// Transforms verified against:
//   - kitchfix-intranet/docs/migrations/inv-1-smart-inventory-schema.sql
//   - kitchfix-intranet/docs/migrations/inv-1-fix-price-history-unique.sql
//   - PR 8.3 recon verified-mapping table (see PR body)
//
// IMPLEMENTATION NOTE: this module transforms the cron's already-built
// Sheets row arrays (newCatalogRows, newAliasRows, etc.) into PG row
// shape. It does NOT re-do the cron's per-result routing (action
// dispatch, arithmetic gate, threshold check) - that logic stays single-
// sourced in processAccount. Vendor resolution happens per Sheets row
// during transform; unresolved vendors skip the row (catalog/alias/price)
// and are tallied for the digest. Queue rows have no vendor_id requirement
// and pass through unconditionally.
// ════════════════════════════════════════════════════════════════════════════

import shapes from "./row-shapes.js";

const VALID_CATEGORIES = new Set(["Food", "Packaging", "Supplies", "Snacks", "Beverages"]);

function sanitizeCategory(c) {
  return VALID_CATEGORIES.has(c) ? c : null;
}

// Initialize the dry-run context once per cron run.
// Returns { supa, shared, vendorMaps } - reused across all account passes.
export async function initPGDryRunContext({ supabaseUrl, supabaseKey }) {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "[pg-dry-run] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for CRON_USE_POSTGRES=dry-run"
    );
  }
  const { createClient } = await import("@supabase/supabase-js");
  const shared = await import("@kitchfix-intranet/shared/inventory-pg");
  const supa = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const vendorMaps = await shared.loadVendorMaps(supa);
  return { supa, shared, vendorMaps };
}

// Paginated read that handles PostgREST's 1000-row default cap.
async function readAllPaginated(supa, table, select, eqCol, eqVal, pageSize = 1000) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supa
      .from(table)
      .select(select)
      .eq(eqCol, eqVal)
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(
        `[pg-dry-run] read ${table}.${select} for ${eqCol}=${eqVal}: ${error.message}`
      );
    }
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Read PG-side processed-invoice IDs for an account.
// Used as the PG half of the dedup union with Sheets, and for divergence
// reporting in the digest.
export async function readPGProcessedInvoices(ctx, accountTab) {
  const rows = await readAllPaginated(
    ctx.supa,
    "price_history",
    "source_or_invoice_id",
    "account",
    accountTab
  );
  return new Set(rows.map((r) => r.source_or_invoice_id).filter(Boolean));
}

// Compute the dedup divergence between Sheets and PG. Pure function.
// Returns counts + up-to-5 sample IDs per side for the digest.
export function computeDedupDivergence(sheetsSet, pgSet) {
  const sheetsOnly = [];
  const pgOnly = [];
  for (const id of sheetsSet) if (!pgSet.has(id)) sheetsOnly.push(id);
  for (const id of pgSet) if (!sheetsSet.has(id)) pgOnly.push(id);
  return {
    sheetsCount: sheetsSet.size,
    pgCount: pgSet.size,
    sheetsOnly: sheetsOnly.length,
    pgOnly: pgOnly.length,
    sheetsOnlySample: sheetsOnly.slice(0, 5),
    pgOnlySample: pgOnly.slice(0, 5),
  };
}

// Per-vendor skip tracker. Aggregates how many rows of each type were
// dropped because the vendor name didn't resolve.
function recordSkip(map, vendorName, rowType) {
  const key = vendorName || "(empty)";
  const existing = map.get(key) || { catalog: 0, alias: 0, price: 0 };
  existing[rowType] = (existing[rowType] || 0) + 1;
  map.set(key, existing);
}

// Build PG row arrays from the cron's Sheets row arrays.
//
// Inputs:
//   ctx          - { supa, shared, vendorMaps } from initPGDryRunContext
//   sheetsRows   - {
//                    catalog: [...newCatalogRows from processAccount],
//                    aliases: [...newAliasRows],
//                    prices:  [...newPriceRows],
//                    queue:   [...newQueueRows]
//                  }
//
// Returns:
//   {
//     rows:  { catalog: [], aliases: [], prices: [], queue: [] },
//     skips: {
//       vendorUnresolved: Map<vendorName, { catalog, alias, price }>,
//       totalRowsSkipped: number,
//       skippedItemIds:   Set<itemId>   // catalog rows skipped; aliases+prices
//                                       // referencing these are also skipped
//     }
//   }
//
// COLUMN COUPLING: Sheets row column positions live in ./row-shapes.js -
// the same module index.js requires() when building these arrays. The
// read*Row helpers below unpack rows by name; if a column ever moves,
// row-shapes.js is the single edit point and both this module and
// processAccount automatically follow. No bare row[N] indexing here.
export function buildPGRowArrays(ctx, sheetsRows) {
  const { resolveVendorId } = ctx.shared;
  const vendorMaps = ctx.vendorMaps;
  const skipsByVendor = new Map();
  const skippedItemIds = new Set();
  let categoryInvalid = 0;

  // ── catalog ──
  const pgCatalog = [];
  for (const row of sheetsRows.catalog) {
    const { itemId, account, name, category, unit, vendor: vendorName, isVariety, createdAt, updatedAt } = shapes.readCatalogRow(row);

    const vendorId = resolveVendorId(vendorName, vendorMaps);
    if (!vendorId) {
      recordSkip(skipsByVendor, vendorName, "catalog");
      skippedItemIds.add(itemId);
      continue;
    }
    const sanitized = sanitizeCategory(category);
    if (category && !sanitized) categoryInvalid += 1;

    pgCatalog.push({
      id:                itemId,
      account:           account,
      name:              name,
      category:          sanitized,       // nullable; defensive sanitize
      unit:              unit,
      location_id:       null,            // cron writes keyword; PG nullable
      vendor_id:         vendorId,
      status:            "active",        // PR 8.3 col-Q overloading fix
      updated_at:        updatedAt,
      linked_to_invoice: true,
      is_variety_group:  isVariety === "TRUE" || isVariety === true,
      created_by:        "ai_cron",
      created_at:        createdAt,
    });
  }

  // ── aliases ──
  const pgAliases = [];
  for (const row of sheetsRows.aliases) {
    const { aliasText, itemId, vendor: vendorName, confidence, learnedBy, learnedAt, source } = shapes.readAliasRow(row);

    if (skippedItemIds.has(itemId)) continue; // parent catalog skipped; no double-count
    const vendorId = resolveVendorId(vendorName, vendorMaps);
    if (!vendorId) {
      recordSkip(skipsByVendor, vendorName, "alias");
      continue;
    }
    pgAliases.push({
      item_id:    itemId,
      alias_text: aliasText,
      vendor_id:  vendorId,
      confidence: confidence,
      learned_by: learnedBy,
      source:     source,                 // already "ai_cron" from processAccount
      learned_at: learnedAt,
    });
  }

  // ── prices ──
  const pgPrices = [];
  for (const row of sheetsRows.prices) {
    const { itemId, account, vendor: vendorName, price, invoiceDate, invoiceUuid, recordedAt } = shapes.readPriceRow(row);

    if (skippedItemIds.has(itemId)) continue;
    const vendorId = resolveVendorId(vendorName, vendorMaps);
    if (!vendorId) {
      recordSkip(skipsByVendor, vendorName, "price");
      continue;
    }
    pgPrices.push({
      item_id:              itemId,
      account:              account,
      vendor_id:            vendorId,
      price:                price,
      effective_date:       invoiceDate || null,
      invoice_id:           invoiceUuid || null,         // UUID FK
      source_or_invoice_id: invoiceUuid || "",           // TEXT dedup key
      source:               "invoice_ocr",               // enum, NOT NULL
      recorded_at:          recordedAt,
      recorded_by:          "ai_cron",
    });
  }

  // ── queue ──
  // No vendor_id requirement; always passes through.
  const pgQueue = [];
  for (const row of sheetsRows.queue) {
    const { lineItemText, vendor, invoiceUuid, invoiceDate, account, suggestedMatchId, suggestedMatchName, confidence, status, reason } = shapes.readQueueRow(row);

    pgQueue.push({
      account:              account,
      item_id:              suggestedMatchId || null,
      line_item_text:       lineItemText,
      vendor:               vendor || null,
      invoice_id:           invoiceUuid || null,
      invoice_date:         invoiceDate || null,
      suggested_match_id:   suggestedMatchId || null,
      suggested_match_name: suggestedMatchName || null,
      confidence:           confidence ?? 0,
      status:               status || "pending",
      reason:               reason,
    });
  }

  let totalRowsSkipped = 0;
  for (const counts of skipsByVendor.values()) {
    totalRowsSkipped += (counts.catalog || 0) + (counts.alias || 0) + (counts.price || 0);
  }

  return {
    rows: { catalog: pgCatalog, aliases: pgAliases, prices: pgPrices, queue: pgQueue },
    skips: {
      vendorUnresolved: skipsByVendor,
      totalRowsSkipped,
      categoryInvalid,
      skippedItemIds,
    },
  };
}

// Format the per-cron-run Slack digest. Single text blob, mrkdwn.
export function formatPGDryRunDigest(perAccountDiffs) {
  let text = "*🔍 PG Dry-Run Digest* (CRON_USE_POSTGRES=dry-run, no PG writes)\n";
  text += `_run ${new Date().toISOString()}_\n\n`;

  let totalCatalog = 0, totalAliases = 0, totalPrices = 0, totalQueue = 0;
  let totalSkipped = 0;
  let totalCategoryInvalid = 0;
  const allUnresolvedVendors = new Map(); // vendorName -> total row count

  text += "*per-account would-write counts:*\n";
  for (const d of perAccountDiffs) {
    if (d.error) {
      text += `• *${d.account}*: ⚠️ ${d.error}\n`;
      continue;
    }
    const { account, would, skips, divergence } = d;
    text += `• *${account}*: ${would.catalog}c / ${would.aliases}a / ${would.prices}p / ${would.queue}q`;
    text += ` | dedup S=${divergence.sheetsCount} P=${divergence.pgCount}`;
    if (divergence.sheetsOnly > 0 || divergence.pgOnly > 0) {
      text += ` (S-only=${divergence.sheetsOnly}, P-only=${divergence.pgOnly})`;
    }
    if (skips.totalRowsSkipped > 0) {
      text += ` | skipped ${skips.totalRowsSkipped} row(s) (vendor-unresolved)`;
    }
    text += "\n";

    totalCatalog += would.catalog;
    totalAliases += would.aliases;
    totalPrices  += would.prices;
    totalQueue   += would.queue;
    totalSkipped += skips.totalRowsSkipped;
    totalCategoryInvalid += skips.categoryInvalid;

    for (const [vendor, counts] of skips.vendorUnresolved) {
      const sum = (counts.catalog || 0) + (counts.alias || 0) + (counts.price || 0);
      allUnresolvedVendors.set(vendor, (allUnresolvedVendors.get(vendor) || 0) + sum);
    }
  }

  text += `\n*aggregate would-write*: ${totalCatalog} catalog / ${totalAliases} aliases / ${totalPrices} prices / ${totalQueue} queue\n`;
  if (totalSkipped > 0) {
    text += `*aggregate skipped (vendor-unresolved)*: ${totalSkipped} row(s)\n`;
  }
  if (totalCategoryInvalid > 0) {
    text += `*category sanitized to NULL*: ${totalCategoryInvalid} row(s) (unmapped category string)\n`;
  }

  if (allUnresolvedVendors.size > 0) {
    text += "\n*unresolved vendors (sorted by impact):*\n";
    const sorted = [...allUnresolvedVendors.entries()].sort((a, b) => b[1] - a[1]);
    for (const [vendor, count] of sorted) {
      text += `• \`${vendor}\` × ${count} row(s)\n`;
    }
  }

  text += "\n_no PG writes performed; Sheets writes ran as today_\n";
  return text;
}

// Post the digest to Slack. Fire-and-forget (catches its own errors).
export async function postPGDryRunDigest(webhookUrl, perAccountDiffs) {
  if (!webhookUrl) {
    console.warn("[pg-dry-run] SLACK_RECAP_WEBHOOK not configured; digest not posted");
    return;
  }
  if (!perAccountDiffs || perAccountDiffs.length === 0) {
    console.log("[pg-dry-run] no per-account diffs; digest skipped");
    return;
  }
  const text = formatPGDryRunDigest(perAccountDiffs);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[pg-dry-run] Slack POST returned ${res.status}: ${await res.text()}`);
      return;
    }
    console.log("[pg-dry-run] digest posted to Slack");
  } catch (e) {
    console.error("[pg-dry-run] Slack post failed:", e.message);
  }
}
