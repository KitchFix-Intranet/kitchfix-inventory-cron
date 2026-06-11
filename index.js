/**
 * kitchfix-inventory-cron — Nightly AI Catalog Matching
 * 
 * Schedule: Midnight CT daily (Railway cron: 0 6 * * * UTC)
 * 
 * Process:
 * 1. Discover account tabs in AI_LINE_ITEMS
 * 2. For each account: find unprocessed line items
 * 3. Send ONE Claude call per account with items + existing catalog
 * 4. Auto-approve >90% confidence → item_catalog + item_aliases + price_history
 * 5. Queue <90% → review_queue
 * 6. Monday: post catalog health digest to Slack
 * 
 * v1.2 — Fixes:
 *   - appendRows uses explicit "tab!A1" range (prevents offset column writes)
 *   - Account matching uses startsWith (handles short vs full account labels)
 *   - Excluded items check via merge_history (prevents re-importing excluded items)
 *   - active column filter handles both boolean false and string "FALSE"
 *   - readTab skips blank/description rows (rows 2-3)
 */

const { google } = require("googleapis");
const shapes = require("./row-shapes.js");

// ── Config ──
const INVENTORY_SHEET_ID = process.env.INVENTORY_SHEET_ID;
const AI_LINE_ITEMS_SHEET_ID = process.env.AI_LINE_ITEMS_SHEET_ID;
const HUB_SHEET_ID = process.env.HUB_SHEET_ID;
// Stage 0 (credit filter): optional. When set, the cron reads
// invoice_submissions_26 from the COLLECTION spreadsheet to find rows
// tagged type='credit' (col P / index 15) and filters their line items
// out of the Claude matching pass. Credits are still extracted + stored
// in ai_line_items for finance; they're only excluded from inventory
// ingestion. If COLLECTION_SHEET_ID is unset, the cron falls back to
// today's behavior (no credit filter) with a single startup warning.
const COLLECTION_SHEET_ID = process.env.COLLECTION_SHEET_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MATCH_CONFIDENCE_THRESHOLD = parseInt(process.env.MATCH_CONFIDENCE_THRESHOLD || "90");
const SLACK_RECAP_WEBHOOK = process.env.SLACK_RECAP_WEBHOOK;

// PR 8.3: cron-to-PG migration flag. 4 modes:
//   false       (default) - Sheets-only writes, today's behavior, no PG access
//   dry-run     - Sheets writes as today + PG reads (dedup union + vendor maps) +
//                 transforms run to compute "would write" + Slack digest. NO PG writes.
//   dual-write  - NOT YET IMPLEMENTED. Reserved for the next PR.
//   pg-only     - NOT YET IMPLEMENTED. Reserved for the post-cutover PR.
const CRON_USE_POSTGRES = (process.env.CRON_USE_POSTGRES || "false").trim();
const VALID_PG_MODES = new Set(["false", "dry-run", "dual-write", "pg-only"]);
if (!VALID_PG_MODES.has(CRON_USE_POSTGRES)) {
  console.error(
    `[cron] Invalid CRON_USE_POSTGRES="${CRON_USE_POSTGRES}". ` +
    `Valid: ${[...VALID_PG_MODES].join(" / ")}.`
  );
  process.exit(2);
}
if (CRON_USE_POSTGRES === "dual-write" || CRON_USE_POSTGRES === "pg-only") {
  console.error(
    `[cron] CRON_USE_POSTGRES="${CRON_USE_POSTGRES}" not yet implemented. ` +
    `PR 8.3 ships "false" + "dry-run" only. ` +
    `Set CRON_USE_POSTGRES=dry-run to validate transforms, or unset for current behavior.`
  );
  process.exit(2);
}
// PR 3: catch-weight derivation mode (paired with intranet PR #133's prompt surgery).
//   off    (default) - derivation never runs. Zero behavior change. Pre-Stage-A invariants hold.
//   shadow           - derivation runs, tallies per-vendor would-recover / would-regress, writes
//                      NOTHING live. Gate still runs on Claude's quantity (current behavior). Slack
//                      digest reports bucket counts + auditable samples for spot-checking against
//                      real invoices. This is the validation window before live cutover.
//   live             - derived quantity REPLACES Claude's quantity at the gate AND for
//                      price_history promotion. Cutover; flip after a clean shadow window
//                      (would-regress sustained 0). Reversible by flipping env var back to shadow/off.
const VALID_DERIVATION_MODES = new Set(["off", "shadow", "live"]);
const CRON_USE_DERIVATION = (process.env.CRON_USE_DERIVATION || "off").trim();
if (!VALID_DERIVATION_MODES.has(CRON_USE_DERIVATION)) {
  console.error(
    `[cron] Invalid CRON_USE_DERIVATION="${CRON_USE_DERIVATION}". ` +
    `Valid: ${[...VALID_DERIVATION_MODES].join(" / ")}. Falling back to off.`
  );
}
const DERIVATION_MODE = VALID_DERIVATION_MODES.has(CRON_USE_DERIVATION) ? CRON_USE_DERIVATION : "off";

// PR A (review-dashboard cron-side foundation): two related behaviors,
// both behind one mode flag and both shadow-tested before flipping live.
//   off    (default) - neither behavior runs. Zero change. Today's loop.
//   shadow           - the cron tallies what it WOULD do under each behavior
//                      below, logs per-account counts to the Slack digest,
//                      but mutates nothing. Validation window before live.
//   live             - actually breaks the chronic-fail loop + stops new
//                      duplicate-re-queue appends. Reversible by flipping back.
//
// Behavior 1 - RESOLVED-STATUS RESPECT (the chronic-fail loop break):
//   Extends processedInvoices to also include invoiceUuids that have ANY
//   review_queue row with status != 'pending' (i.e. accepted or rejected
//   by the future dashboard's resolve/skip actions). Today this is a no-op
//   because 0 rows are non-pending (the queue has never resolved a single
//   row), but it's the foundation the dashboard's resolve action will rely
//   on: when the human marks a line resolved, the cron will stop re-trying
//   the whole invoice on subsequent nights. This is the Option B mechanic
//   (read the status flag) chosen over Option A (write a fake quantity=0
//   price_history row) - no lies in price_history.
//
// Behavior 2 - RE-QUEUE DEDUP GUARD (stop the balloon):
//   When the gate fails a line and processAccount would append a new
//   review_queue row, FIRST check whether a row already exists for the
//   same (invoiceUuid, lineItemText) with status='pending'. If so, do NOT
//   append a duplicate. The recon found 677 of the 1,056 review_queue
//   rows (64%) are duplicate re-fires from chronic-fail invoices the
//   cron re-tries every night; one Cheney invoice's lines had been
//   re-queued 14 times each. Without this guard the queue keeps growing
//   silently every night.
//
// SCOPE FENCE: PR A is ONLY the cron-side foundation. It does NOT touch
// the 677 existing duplicate rows (that's PR D, a one-time cleanup with
// its own show-me-before-delete gate). It does NOT add the dashboard UI
// (that's PR B, layers on top once A is proven live). It does NOT add
// bulk-resolve (PR C).
const VALID_REVIEW_QUEUE_RESPECT_MODES = new Set(["off", "shadow", "live"]);
const CRON_REVIEW_QUEUE_RESPECT = (process.env.CRON_REVIEW_QUEUE_RESPECT || "off").trim();
if (!VALID_REVIEW_QUEUE_RESPECT_MODES.has(CRON_REVIEW_QUEUE_RESPECT)) {
  console.error(
    `[cron] Invalid CRON_REVIEW_QUEUE_RESPECT="${CRON_REVIEW_QUEUE_RESPECT}". ` +
    `Valid: ${[...VALID_REVIEW_QUEUE_RESPECT_MODES].join(" / ")}. Falling back to off.`
  );
}
const REVIEW_QUEUE_RESPECT_MODE = VALID_REVIEW_QUEUE_RESPECT_MODES.has(CRON_REVIEW_QUEUE_RESPECT) ? CRON_REVIEW_QUEUE_RESPECT : "off";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Sheets Auth ──
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

const sheets = getSheetsClient();

// ── Account matching (handles "STL - MO" vs "STL - MO - St Louis Cardinals") ──
function accountMatch(rowAccount, activeAccount) {
  if (!rowAccount || !activeAccount) return false;
  if (rowAccount === activeAccount) return true;
  return rowAccount.startsWith(activeAccount + " -") || activeAccount.startsWith(rowAccount + " -");
}

// ── Sheet Helpers ──
async function readTab(spreadsheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabName });
    const data = res.data.values || [];
    if (data.length <= 1) return []; // header only or empty
    // Skip header (row 1), blank row (row 2), description row (row 3)
    // Filter: rows must have a value in column A to be real data
    return data.slice(1).filter(r => r[0] && !String(r[0]).startsWith("One row") && !String(r[0]).startsWith("Multiple") && !String(r[0]).startsWith("Every ") && !String(r[0]).startsWith("Per-account") && !String(r[0]).startsWith("Append-only") && !String(r[0]).startsWith("Pending"));
  } catch (e) {
    console.warn(`[read] ${tabName}: ${e.message}`);
    return [];
  }
}

async function appendRows(spreadsheetId, tabName, rows) {
  if (!rows.length) return;
  // CRITICAL: Use "tab!A1" range to force append at column A
  // Using bare tab name causes Sheets to detect existing data boundaries
  // and append at the wrong column position
  const range = tabName.includes("!") ? tabName : `${tabName}!A1`;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  } catch (e) {
    console.error(`[append] ${tabName}: ${e.message}`);
  }
}

async function updateRange(spreadsheetId, range, values) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
  } catch (e) {
    console.error(`[update] ${range}: ${e.message}`);
  }
}

async function getTabNames(spreadsheetId) {
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId, fields: "sheets.properties.title",
    });
    return (res.data.sheets || []).map((s) => s.properties.title);
  } catch (e) {
    console.error(`[tabs] ${e.message}`);
    return [];
  }
}

function uid() {
  const h = () => Math.random().toString(16).slice(2, 10);
  return `${h()}-${h().slice(0, 4)}-${h().slice(0, 4)}-${h()}`;
}

// ── Normalize name for dedup comparison ──
function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "") // strip all non-alphanumeric
    .trim();
}

// ── Arithmetic gate: catches bad OCR reads at the price chokepoint. ──
// Holds: |qty*unitPrice - extendedPrice| <= 2% of |extendedPrice| + 0.01
// Tolerates rounding / cents drift; catches order-of-magnitude misreads.
// Lines that fail this gate are NOT promoted to price_history /
// item_catalog; they route to review_queue with reason="arithmetic_fail".
// Module 8 will add the price-vs-history outlier check on top of this.
function arithmeticCheck(li) {
  const calc = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
  const ext = Number(li.extendedPrice) || 0;
  const tol = 0.02 * Math.abs(ext) + 0.01;
  return Math.abs(calc - ext) <= tol;
}

// ── Catch-weight derivation (PR 3) ──
// Source of truth for the cron's catch-weight handling. Reads Stage A raw
// fields off the line item (populated by intranet PR #133 into ai_line_items
// Sheets cols P-X) and returns the quantity-for-pricing the gate + price
// promotion should use.
//
// Detects STRUCTURALLY (weightLineValue present), NEVER by price magnitude.
// NEVER back-computes from amount / unitPrice (the circular-gate bug that
// failed the original Stage A held-out test). A null result is honest; it
// routes the line to review_queue, NOT to a back-computed pass.
//
// MIRROR of scripts/_probe_stage_a_extraction.mjs's deriveLineItemQuantity
// in the intranet repo (PR #133). If the two diverge, fix BOTH at the same
// time so the held-out probe stays predictive of production behavior.
//
// Legacy pre-Stage-A rows have weightLineValue + shippedCount as empty
// strings on the Sheets tab. parseFloat("") yields NaN; Number.isFinite
// rejects NaN; both branches fall through to the honest_null_review
// outcome. Callers in shadow mode treat this as "no derived value, leave
// li.quantity alone for the gate"; callers in live mode would set
// li.quantity = null which routes the line to review_queue. (In practice
// legacy invoices never reach here because they're filtered out by the
// processedInvoices dedup before the gate runs.)
function deriveLineItemQuantity(li) {
  const w = Number(li.weightLineValue);
  if (Number.isFinite(w) && w > 0) {
    return { quantity: w, unit: "lb", reason: "catch_weight_subline" };
  }
  const s = Number(li.shippedCount);
  if (Number.isFinite(s) && s !== 0) {
    return { quantity: s, unit: li.unit || "case", reason: "shipped_passthrough" };
  }
  return { quantity: null, unit: null, reason: "honest_null_review" };
}

// ── Claude API ──
async function callClaude(prompt, maxTokens = 8192) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

// ── Build Claude Prompt ──
function buildMatchPrompt(lineItems, catalog, aliases) {
  const catalogSummary = catalog.length > 0
    ? catalog.map((c) => `  - ID:${c.itemId} | "${c.name}" | ${c.category} | ${c.unit} | vendor:${c.primaryVendor}`).join("\n")
    : "  (empty catalog — all items are new)";

  const aliasSummary = aliases.length > 0
    ? aliases.map((a) => `  - "${a.aliasText}" → ID:${a.canonicalItemId} (${a.vendor})`).join("\n")
    : "  (no aliases yet)";

  const itemsList = lineItems.map((li, i) =>
    `  ${i}: desc="${li.description}" | vendor="${li.vendor}" | qty=${li.quantity} | unit="${li.unit}" | price=${li.unitPrice} | cat="${li.category}" | invoiceId="${li.invoiceUuid}"`
  ).join("\n");

  return `You are a food service inventory matching engine. Your job is to process invoice line items and either match them to existing catalog items or create new catalog entries.

EXISTING CATALOG:
${catalogSummary}

EXISTING ALIASES:
${aliasSummary}

NEW LINE ITEMS TO PROCESS:
${itemsList}

RULES — apply ALL of these in one pass:

SKIP (return action:"skip"):
- Totals, subtotals, grand totals, surcharges, fees, credits, tax lines, delivery fees
- Items with category "smallwares" or "service"
- Garbled/unreadable descriptions (flag reason:"garbled")

NORMALIZE:
- Units: cs→case, ea→each, gal→gallon, lb→pound, oz→ounce, pk→pack, bg→bag, ct→count, dz→dozen
- Fix implausible unit/price combos: $24/oz is probably $24/each, $0.03/case is probably $0.03/each
- Clean up ALL-CAPS descriptions to Title Case
- Remove item numbers, asterisks, special characters from descriptions

CATEGORY MAPPING (map to these 5 GL categories):
- protein, produce, dairy, dry_goods, bakery, frozen → "Food"
- beverage, drinks → "Beverages"
- packaging, paper, disposable → "Packaging"
- cleaning, chemical, janitorial → "Supplies"
- Detect snacks by product type regardless of vendor category: chips, bars, jerky, pretzels, popcorn, trail mix, candy, dried fruit, cookies, crackers → "Snacks"
- Items categorized as "other" — reclassify into the correct category above based on the description

VARIETY GROUPING:
- Same brand + same pack size + same or very similar price = ONE catalog entry
- Example: "Deep River Kettle Chips BBQ 24/2oz" and "Deep River Kettle Chips Sea Salt 24/2oz" → one entry "Deep River Kettle Chips 24/2oz"
- Individual flavor names become aliases

MATCHING:
- Compare each item against the existing catalog AND aliases
- Return confidence 0-100:
  - 95-100: Exact or near-exact match (same item, minor spelling/abbreviation difference)
  - 80-94: Very likely match (same product, different vendor description style)
  - 60-79: Possible match (similar product, needs human review)
  - 0-59: No match (new item)
- If confidence >= 60, return the matched catalogItemId
- If confidence < 60, this is a new item — provide a clean canonical name
- CRITICAL matching rules — these are ALL 95+ confidence matches:
  - "30 Pack" vs "30pk" vs "30ct" vs "30 count" → SAME ITEM
  - Missing or extra hyphens, dashes, spaces → SAME ITEM
  - "Ea" vs "Each" vs "1ct" → same unit
  - Same brand + same size + same vendor = same item even if word order differs
  - Same brand + same size + different vendor = MATCH to existing item (different source, same product)
  - Abbreviations: "Chix" = "Chicken", "Org" = "Organic", "Shrd" = "Shredded", "Med" = "Medium", "Lg" = "Large", "Sm" = "Small"

BATCH DEDUP (CRITICAL — prevents duplicate catalog entries):
- BEFORE returning results, scan your own output for items that would create the same catalog entry
- If two or more items in THIS BATCH resolve to the same product:
  - The FIRST occurrence: action "new" (or "match") as normal
  - ALL subsequent occurrences of the same product: action "batch_match" with "batchRefIndex" pointing to the first occurrence's index
  - This ensures only ONE catalog entry is created per unique product per batch
- Example: index 3 = "Jarritos 24pk" from Grey Eagle, index 17 = "Jarritos 24pk" from Grey Eagle:
  - Index 3: { "action": "new", "canonicalName": "Jarritos 24pk", ... }
  - Index 17: { "action": "batch_match", "batchRefIndex": 3, "canonicalName": "Jarritos 24pk", ... }

STORAGE LOCATION SUGGESTION (for new items only):
Suggest where this item is physically stored in a commercial kitchen:
- "cooler" — fresh proteins, dairy, produce, eggs, fresh herbs, dressings, anything requiring 35-41°F
- "freezer" — frozen proteins, frozen vegetables, ice cream, frozen bread, anything requiring 0°F or below. Look for keywords: frozen, IQF, flash frozen, frost
- "dry" — shelf-stable items: canned goods, rice, pasta, flour, sugar, spices, oils, vinegar, dry beans, crackers, chips, snacks, bars, trail mix, candy, cookies
- "beverage" — water, soda, juice, sports drinks, coffee, tea, energy drinks, milk alternatives for beverage service
- "supplies" — cleaning chemicals, sanitizer, gloves, foil, plastic wrap, paper towels, trash bags, packaging materials, to-go containers, disposables

RESPOND WITH ONLY valid JSON (no markdown, no backticks, no explanation):
{
  "results": [
    {
      "index": 0,
      "action": "match" | "new" | "skip" | "batch_match",
      "confidence": 95,
      "matchedItemId": "existing-item-id-if-matched",
      "batchRefIndex": null,
      "canonicalName": "Clean Item Name",
      "category": "Food",
      "unit": "case",
      "normalizedPrice": 24.50,
      "suggestedStorage": "cooler",
      "skipReason": "noise" | "garbled" | "smallwares" | null,
      "isVarietyOf": "parent-item-id-or-null",
      "varietyGroupName": "Brand PackSize"
    }
  ]
}`;
}

// ── Process One Account ──
// pgCtx (optional): { supa, shared, vendorMaps, module } - set when
// CRON_USE_POSTGRES === "dry-run". Triggers PG dedup read (union with
// Sheets), PG row-array transform after Claude results, and the per-
// account diff that main() collects for the Slack digest. Writes nothing
// to PG.
async function processAccount(accountTab, pgCtx) {
  console.log(`\n[${accountTab}] Processing...`);

  // 1. Read line items from AI_LINE_ITEMS
  const rawItems = await readTab(AI_LINE_ITEMS_SHEET_ID, accountTab);
  if (rawItems.length === 0) {
    console.log(`[${accountTab}] No line items, skipping.`);
    return { account: accountTab, processed: 0, matched: 0, created: 0, queued: 0, skipped: 0 };
  }

  const lineItems = rawItems.map((r) => ({
    invoiceUuid: r[0] || "", timestamp: r[1] || "", account: r[2] || "",
    vendor: r[3] || "", invoiceNumber: r[4] || "", invoiceDate: r[5] || "",
    lineNum: r[6] || 0, description: r[7] || "", quantity: parseFloat(r[8]) || 0,
    unit: r[9] || "", unitPrice: parseFloat(r[10]) || 0, extendedPrice: parseFloat(r[11]) || 0,
    category: r[12] || "other",
    // ── Stage A raw labeled fields (intranet PR #133) ──
    // Sheets cols P-W (indices 15-22). Col X (raw_columns) is a backstop
    // dump kept as a future hook and intentionally NOT read here.
    // Empty strings on legacy pre-Stage-A rows; parseFloat("") yields NaN
    // and deriveLineItemQuantity's Number.isFinite checks reject NaN, so
    // legacy rows fall through to honest_null_review (no derivation effect).
    itemNumber:        r[15] || null,
    packSize:          r[16] || null,
    orderedCount:      r[17] !== "" && r[17] != null ? parseFloat(r[17]) : null,
    shippedCount:      r[18] !== "" && r[18] != null ? parseFloat(r[18]) : null,
    uomRaw:            r[19] || null,
    amount:            r[20] !== "" && r[20] != null ? parseFloat(r[20]) : null,
    weightLineValue:   r[21] !== "" && r[21] != null ? parseFloat(r[21]) : null,
    catchWeightMarker: r[22] || null,
  }));

  // 2. Read existing catalog + aliases + price_history + merge_history for this account
  const [catalogRows, aliasRows, priceRows, mergeRows, invoiceSubmissionRows] = await Promise.all([
    readTab(INVENTORY_SHEET_ID, "item_catalog"),
    readTab(INVENTORY_SHEET_ID, "item_aliases"),
    readTab(INVENTORY_SHEET_ID, "price_history"),
    readTab(INVENTORY_SHEET_ID, "merge_history"),
    // Stage 0 (credit filter): read invoice_submissions_26 to identify
    // credit memos so their line items can be skipped from inventory
    // ingestion. Returns [] when COLLECTION_SHEET_ID is unset (the
    // filter then no-ops at the filter block below).
    COLLECTION_SHEET_ID ? readTab(COLLECTION_SHEET_ID, "invoice_submissions_26") : Promise.resolve([]),
  ]);

  // Use accountMatch for flexible matching (short label vs full label)
  const catalog = catalogRows
    .filter((r) => accountMatch(r[1], accountTab) && r[11] !== "FALSE" && r[11] !== false)
    .map((r) => ({
      itemId: r[0], name: r[2], category: r[3], unit: r[4],
      locationId: r[5], primaryVendor: r[6], lastPrice: r[7],
    }));

  const aliases = aliasRows
    .filter((r) => catalog.some((c) => c.itemId === r[2]))
    .map((r) => ({ aliasId: r[0], aliasText: r[1], canonicalItemId: r[2], vendor: r[3] }));

  // Build excluded items set from merge_history (action="exclude")
  const excludedNames = new Set();
  mergeRows.forEach((r) => {
    // merge_history columns: mergeId[0], account[1], timestamp[2], email[3], keeperItemId[4], keeperName[5], mergedItemIds[6], mergedNames[7], action[8], aiGroupId[9]
    if (r[8] === "exclude" && accountMatch(r[1], accountTab)) {
      const name = normalizeName(r[5]); // keeperName has the item name
      if (name) excludedNames.add(name);
    }
  });
  if (excludedNames.size > 0) {
    console.log(`[${accountTab}] ${excludedNames.size} excluded item(s) will be skipped`);
  }

  // 3. Filter to unprocessed items — skip if invoiceUuid already in price_history
  const sheetsProcessedInvoices = new Set(
    priceRows.filter((r) => accountMatch(r[1], accountTab)).map((r) => r[5]) // invoiceId
  );

  // PR 8.3 dry-run: also read PG-side processed invoices for the dedup union.
  // Over-skip (union) rather than re-process (intersection) so divergence
  // between Sheets and PG never causes the cron to re-write a row that
  // either side already has.
  let pgProcessedInvoices = new Set();
  if (pgCtx) {
    try {
      pgProcessedInvoices = await pgCtx.module.readPGProcessedInvoices(pgCtx, accountTab);
    } catch (e) {
      console.error(`[${accountTab}] [pg-dry-run] PG processed-invoices read failed (falling back to Sheets-only dedup):`, e.message);
    }
  }
  const processedInvoices = pgCtx
    ? new Set([...sheetsProcessedInvoices, ...pgProcessedInvoices])
    : sheetsProcessedInvoices;

  let newItems = lineItems.filter((li) => !processedInvoices.has(li.invoiceUuid));

  // Invoice-level holds. review_queue rows tagged
  // reason='overcount_suspect_reextract' flag entire invoices whose
  // extracted line totals exceed the invoice total (real + fabricated
  // mix). Their lines stay in ai_line_items for audit and future
  // re-source; they do NOT promote here. Backfill or chef resolver
  // writes these rows. Filtered out of newItems before the Claude
  // call so they never reach the matching pass.
  const queueRowsForHolds = await readTab(INVENTORY_SHEET_ID, "review_queue");
  const heldInvoiceUuids = new Set();
  for (const r of queueRowsForHolds) {
    if (String(r[13] || "").trim() === "overcount_suspect_reextract" && accountMatch(r[5], accountTab)) {
      const inv = String(r[3] || "").trim();
      if (inv) heldInvoiceUuids.add(inv);
    }
  }
  let invoiceHoldsHonored = 0, linesDeferredByHold = 0;
  if (heldInvoiceUuids.size > 0) {
    const wasCount = newItems.length;
    const skippedSet = new Set();
    newItems = newItems.filter((li) => {
      if (heldInvoiceUuids.has(li.invoiceUuid)) {
        skippedSet.add(li.invoiceUuid);
        return false;
      }
      return true;
    });
    invoiceHoldsHonored = skippedSet.size;
    linesDeferredByHold = wasCount - newItems.length;
    if (linesDeferredByHold > 0) {
      console.log(`[${accountTab}] honored invoice-level holds: ${invoiceHoldsHonored} invoice(s), ${linesDeferredByHold} line(s) deferred (reason=overcount_suspect_reextract)`);
    }
  }

  // ── PR A: review-queue-respect (shadow/live behind CRON_REVIEW_QUEUE_RESPECT) ──
  // Two sets built from the SAME queueRowsForHolds read used above:
  //   resolvedInvoiceUuids: invoiceUuid for which any review_queue row has
  //     status != 'pending'. Used to break the chronic-fail loop once the
  //     future dashboard (PR B) writes resolutions. Today this is a no-op
  //     because every queue row is status='pending' (recon: 1,056/1,056).
  //   pendingQueueKeys: "invoiceUuid::lineItemText" tuples that already
  //     have a status='pending' review_queue row. Used by the
  //     gate-fail append site below to suppress duplicate re-queue rows
  //     (the recon found 677 of 1,056 queue rows -- 64% -- are duplicates
  //     re-fired every night by chronic-fail invoices).
  const resolvedInvoiceUuids = new Set();
  const pendingQueueKeys = new Set();
  if (REVIEW_QUEUE_RESPECT_MODE !== "off") {
    for (const r of queueRowsForHolds) {
      if (!accountMatch(r[5], accountTab)) continue;     // account scope (col F)
      const uuid = String(r[3] || "").trim();             // col D: invoiceUuid
      if (!uuid) continue;
      const status = String(r[9] || "").trim().toLowerCase(); // col J: status
      if (status && status !== "pending") {
        resolvedInvoiceUuids.add(uuid);
      } else {
        // Treat blank status as pending (legacy rows have empty status).
        const lineText = String(r[1] || "").trim();       // col B: lineItemText
        pendingQueueKeys.add(`${uuid}::${lineText}`);
      }
    }
  }

  // Behavior 1: resolved-status respect. In shadow we count what WOULD be
  // skipped; in live we actually skip. Today's shadow count is expected to
  // be 0 since no row has ever been resolved -- this is the foundation PR B
  // builds on.
  let resolvedRespectInvoiceCount = 0;
  let resolvedRespectLineCount = 0;
  if (REVIEW_QUEUE_RESPECT_MODE !== "off" && resolvedInvoiceUuids.size > 0) {
    const matched = newItems.filter((li) => resolvedInvoiceUuids.has(li.invoiceUuid));
    const matchedInvoiceSet = new Set(matched.map((li) => li.invoiceUuid));
    resolvedRespectInvoiceCount = matchedInvoiceSet.size;
    resolvedRespectLineCount = matched.length;
    if (REVIEW_QUEUE_RESPECT_MODE === "live") {
      newItems = newItems.filter((li) => !resolvedInvoiceUuids.has(li.invoiceUuid));
      console.log(`[${accountTab}] [review-queue-respect/live] skipped ${resolvedRespectInvoiceCount} resolved invoice(s), ${resolvedRespectLineCount} line(s)`);
    } else {
      console.log(`[${accountTab}] [review-queue-respect/shadow] WOULD skip ${resolvedRespectInvoiceCount} resolved invoice(s), ${resolvedRespectLineCount} line(s)`);
    }
  }

  // ── Credit filter (Stage 0) ──
  // invoice_submissions rows with type='credit' represent credit memos.
  // They're real financial records (already extracted and stored in
  // ai_line_items for accounting), but their line items must NOT feed
  // inventory pricing or catalog. Filter them out at the same pre-Claude
  // gate as overcount holds.
  //
  // Source: invoice_submissions_26 in the COLLECTION spreadsheet.
  // Columns (per src/lib/dataStore/invoice.js SUB_IDX):
  //   col 0  (A) = uuid (client_uuid; matches ai_line_items.invoiceUuid)
  //   col 3  (D) = account
  //   col 15 (P) = type ('invoice' | 'credit', default 'invoice')
  //
  // No-op when COLLECTION_SHEET_ID is unset (invoiceSubmissionRows = []).
  let creditsSkipped = 0, linesSkippedByCredit = 0;
  {
    const creditUuids = new Set();
    for (const r of invoiceSubmissionRows || []) {
      if (String(r[15] || "").trim() === "credit" && accountMatch(r[3], accountTab)) {
        const u = String(r[0] || "").trim();
        if (u) creditUuids.add(u);
      }
    }
    if (creditUuids.size > 0) {
      const wasCount = newItems.length;
      const skippedSet = new Set();
      newItems = newItems.filter((li) => {
        if (creditUuids.has(li.invoiceUuid)) {
          skippedSet.add(li.invoiceUuid);
          return false;
        }
        return true;
      });
      creditsSkipped = skippedSet.size;
      linesSkippedByCredit = wasCount - newItems.length;
      if (linesSkippedByCredit > 0) {
        console.log(`[${accountTab}] credit memos skipped: ${creditsSkipped} invoice(s), ${linesSkippedByCredit} line(s) deferred (type=credit on invoice_submissions)`);
      }
    }
  }

  if (newItems.length === 0) {
    console.log(`[${accountTab}] All ${lineItems.length} items already processed.`);
    return { account: accountTab, processed: 0, matched: 0, created: 0, queued: 0, skipped: 0 };
  }

  console.log(`[${accountTab}] ${newItems.length} new items (${lineItems.length} total, ${catalog.length} in catalog)`);

  // 4. Call Claude in batches of 50 items
  const BATCH_SIZE = 50;
  let results = [];
  for (let batchStart = 0; batchStart < newItems.length; batchStart += BATCH_SIZE) {
    const batch = newItems.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(newItems.length / BATCH_SIZE);
    console.log(`[${accountTab}] Batch ${batchNum}/${totalBatches} (${batch.length} items)`);

    const prompt = buildMatchPrompt(batch, catalog, aliases);
    try {
      const raw = await callClaude(prompt, 16384);
      const cleaned = raw.replace(/```json\s*|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      // Offset indices to match original newItems array position
      const batchResults = (parsed.results || []).map((r) => ({
        ...r,
        index: r.index + batchStart,
        // Offset batchRefIndex too if present
        batchRefIndex: r.batchRefIndex != null ? r.batchRefIndex + batchStart : null,
      }));
      results = results.concat(batchResults);
    } catch (e) {
      console.error(`[${accountTab}] Batch ${batchNum} Claude error: ${e.message}`);
      // Continue with other batches instead of failing the whole account
    }

    // Delay between batches to avoid rate limits
    if (batchStart + BATCH_SIZE < newItems.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── Post-process: code-level dedup (catches anything Claude missed) ──
  const newByName = {};
  for (const r of results) {
    if (r.action === "new" && r.canonicalName) {
      const key = normalizeName(r.canonicalName);
      if (newByName[key] !== undefined) {
        // Duplicate "new" — convert to batch_match
        console.log(`[${accountTab}] Dedup: index ${r.index} "${r.canonicalName}" → batch_match of index ${newByName[key]}`);
        r.action = "batch_match";
        r.batchRefIndex = newByName[key];
      } else {
        newByName[key] = r.index;
      }
    }
  }

  // Also check "new" items against the existing catalog (Claude sometimes misses)
  for (const r of results) {
    if (r.action === "new" && r.canonicalName) {
      const key = normalizeName(r.canonicalName);
      const existingMatch = catalog.find((c) => normalizeName(c.name) === key);
      if (existingMatch) {
        console.log(`[${accountTab}] Dedup vs catalog: index ${r.index} "${r.canonicalName}" matches existing "${existingMatch.name}" (${existingMatch.itemId})`);
        r.action = "match";
        r.matchedItemId = existingMatch.itemId;
        r.confidence = 95;
      }
    }
  }

  // Check "new" items against excluded items — skip if name matches
  for (const r of results) {
    if (r.action === "new" && r.canonicalName) {
      const key = normalizeName(r.canonicalName);
      if (excludedNames.has(key)) {
        console.log(`[${accountTab}] Excluded: index ${r.index} "${r.canonicalName}" was previously removed from inventory`);
        r.action = "skip";
        r.skipReason = "excluded";
      }
    }
  }

  // Sort: process "new" before "batch_match" so IDs exist when referenced
  results.sort((a, b) => {
    const order = { skip: 0, new: 1, match: 2, batch_match: 3 };
    return (order[a.action] || 9) - (order[b.action] || 9);
  });

  // 5. Process results
  const now = new Date().toISOString();
  const newCatalogRows = [];
  const newAliasRows = [];
  const newPriceRows = [];
  const newQueueRows = [];
  const batchNewIds = {}; // index → generated itemId (for batch_match resolution)
  let matched = 0, created = 0, queued = 0, held = 0, skipped = 0;

  // ── PR A: re-queue dedup guard ──
  // Wrap newQueueRows.push to check whether a row already exists for the
  // same (invoiceUuid, lineItemText) with status='pending'. Shadow tallies
  // what would be suppressed; live actually suppresses. Off no-ops.
  // Indices match shapes.QUEUE_COLS: [0]=queueId [1]=lineItemText [3]=invoiceUuid
  let reQueueSuppressed = 0;
  function maybePushQueueRow(row) {
    if (REVIEW_QUEUE_RESPECT_MODE === "off" || pendingQueueKeys.size === 0) {
      newQueueRows.push(row);
      return;
    }
    const uuid = String(row[3] || "").trim();
    const lineText = String(row[1] || "").trim();
    const key = `${uuid}::${lineText}`;
    const alreadyPending = pendingQueueKeys.has(key);
    if (!alreadyPending) {
      newQueueRows.push(row);
      return;
    }
    reQueueSuppressed++;
    if (REVIEW_QUEUE_RESPECT_MODE === "live") {
      return;                  // skip the append (real dedup)
    }
    newQueueRows.push(row);    // shadow: still append, tally only
  }

  // PR 3: catch-weight derivation shadow tally. Only populated when
  // DERIVATION_MODE !== "off". Buckets per the held-out probe + PR 3 spec:
  //   wouldRecover - currentGate FAIL, derivedGate PASS (the win)
  //   wouldRegress - currentGate PASS, derivedGate FAIL or HELD (the alarm; must stay 0)
  //   noChange     - currentGate PASS, derivedGate PASS
  //   residual     - currentGate FAIL, derivedGate FAIL or HELD (review-queue floor)
  // Samples capture vendor / invoice# / desc / old qty / new qty + reason
  // so Kevin can pull the invoice and spot-check that the recovered quantity
  // is genuinely correct, not just arithmetically footing.
  const derivationTally = { wouldRecover: 0, wouldRegress: 0, noChange: 0, residual: 0 };
  const derivationByVendor = new Map();
  const wouldRecoverSamples = [];
  const wouldRegressSamples = [];
  const SAMPLE_LIMIT_PER_ACCOUNT = 5;

  // PR 6 (durable catch-weight log): durable record of every catch_weight_subline
  // derivation the cron detects. UNCAPPED per account (every detection goes to
  // the log tab, unlike the digest samples which are capped at 5/account). The
  // Slack-digest samples evaporate; this tab persists. Append-only; gets one
  // batched append per account at the end of processAccount.
  const catchWeightDetections = [];

  for (const r of results) {
    const li = newItems[r.index];
    if (!li) continue;

    if (r.action === "skip") {
      skipped++;
      continue;
    }

    // Arithmetic gate at the price-write chokepoint. Applies only to
    // actions that would otherwise promote to price_history /
    // item_catalog (match-high-conf, new-genuine, batch_match). The
    // low-confidence-match and possible-new branches already route to
    // review_queue with their own reasons; arithmetic is checked on the
    // promotion path so bad reads can't corrupt prices.
    const wouldPromote =
      (r.action === "match" && r.matchedItemId && r.confidence >= MATCH_CONFIDENCE_THRESHOLD) ||
      (r.action === "new" && !(r.confidence !== undefined && r.confidence >= 60)) ||
      (r.action === "batch_match");

    // PR 3: catch-weight derivation. Scope intentionally limited to wouldPromote
    // lines, same scope as the gate. Off / shadow / live modes:
    //   off    - no-op; current behavior preserved exactly.
    //   shadow - compute derived, run the gate on both Claude's and derived
    //            quantities, tally per-vendor, collect samples for spot-checking.
    //            Does NOT mutate li.
    //   live   - mutate li.quantity + li.unit to derived values BEFORE the gate
    //            runs, so the gate + downstream price_history use the derived
    //            quantity. Honest-null becomes li.quantity = null and the gate
    //            then fails so the line routes to review_queue.
    if (wouldPromote && DERIVATION_MODE !== "off") {
      const derived = deriveLineItemQuantity(li);

      // PR 6 (durable log): capture every catch_weight_subline detection
      // regardless of shadow/live mode. Logged at end of processAccount.
      // shipped_passthrough is a no-op (qty unchanged), not worth logging.
      // honest_null_review means derivation tried but had no weight to use -
      // also not the cron's "I detected a catch-weight" case.
      if (derived.reason === "catch_weight_subline") {
        catchWeightDetections.push({
          timestamp:        new Date().toISOString(),
          account:          accountTab,
          vendor:           li.vendor || "",
          invoiceUuid:      li.invoiceUuid || "",
          invoiceNumber:    li.invoiceNumber || "",
          description:      li.description || "",
          oldQty:           li.quantity,
          oldUnit:          li.unit || "",
          derivedQty:       derived.quantity,
          derivedUnit:      derived.unit,
          unitPrice:        li.unitPrice,
          amount:           li.extendedPrice,
          derivationReason: derived.reason,
          cronMode:         DERIVATION_MODE,
        });
      }

      if (DERIVATION_MODE === "shadow") {
        const currentPass = arithmeticCheck(li);
        let derivedPass;
        let derivedGateLabel;
        if (derived.quantity == null) {
          derivedPass = false;
          derivedGateLabel = "HELD";
        } else {
          derivedPass = arithmeticCheck({ ...li, quantity: derived.quantity });
          derivedGateLabel = derivedPass ? "PASS" : "FAIL";
        }

        let bucket;
        if (!currentPass && derivedPass) bucket = "wouldRecover";
        else if (currentPass && !derivedPass) bucket = "wouldRegress";
        else if (currentPass && derivedPass) bucket = "noChange";
        else bucket = "residual";

        derivationTally[bucket]++;
        const v = li.vendor || "(no vendor)";
        if (!derivationByVendor.has(v)) {
          derivationByVendor.set(v, { wouldRecover: 0, wouldRegress: 0, noChange: 0, residual: 0 });
        }
        derivationByVendor.get(v)[bucket]++;

        // Sample collection: capped per account so a single noisy account
        // can't drown the digest. Top-level aggregator slices to the global
        // sample budget downstream (see buildDerivationShadowSection).
        if (bucket === "wouldRecover" && wouldRecoverSamples.length < SAMPLE_LIMIT_PER_ACCOUNT) {
          wouldRecoverSamples.push({
            account: accountTab,
            vendor: li.vendor, invoiceNumber: li.invoiceNumber, description: li.description,
            oldQty: li.quantity, oldUnit: li.unit,
            newQty: derived.quantity, newUnit: derived.unit,
            unitPrice: li.unitPrice, amount: li.extendedPrice,
            derivedReason: derived.reason,
          });
        }
        if (bucket === "wouldRegress" && wouldRegressSamples.length < SAMPLE_LIMIT_PER_ACCOUNT) {
          wouldRegressSamples.push({
            account: accountTab,
            vendor: li.vendor, invoiceNumber: li.invoiceNumber, description: li.description,
            oldQty: li.quantity, oldUnit: li.unit,
            newQty: derived.quantity, newUnit: derived.unit,
            unitPrice: li.unitPrice, amount: li.extendedPrice,
            derivedGateResult: derivedGateLabel, derivedReason: derived.reason,
          });
        }
      } else if (DERIVATION_MODE === "live") {
        // Replace li's quantity-for-pricing with the derived value. Both
        // the gate (below) and the downstream price_history writer use
        // li.quantity, so this single mutation drives both.
        if (derived.quantity != null) {
          li.quantity = derived.quantity;
          li.unit = derived.unit;
        } else {
          // Honest null sets quantity to null so the gate fails and the
          // line routes to review_queue rather than silently promoting a
          // back-computed value.
          li.quantity = null;
        }
      }
    }

    if (wouldPromote && !arithmeticCheck(li)) {
      held++;
      maybePushQueueRow(shapes.makeQueueRow({
        queueId:            `q_${uid()}`,
        lineItemText:       li.description,
        vendor:             li.vendor,
        invoiceUuid:        li.invoiceUuid,
        invoiceDate:        li.invoiceDate,
        account:            accountTab,
        suggestedMatchId:   r.matchedItemId || "",
        suggestedMatchName: r.canonicalName || li.description,
        confidence:         r.confidence ?? 0,
        status:             "pending",
        reserved10:         "",
        reserved11:         "",
        reserved12:         "",
        reason:             "arithmetic_fail",
      }));
      continue;
    }

    if (r.action === "match" && r.matchedItemId) {
      if (r.confidence >= MATCH_CONFIDENCE_THRESHOLD) {
        // Auto-approve: add alias + update price
        matched++;
        newAliasRows.push(shapes.makeAliasRow({
          aliasId:    `alias_${uid()}`,
          aliasText:  li.description,
          itemId:     r.matchedItemId,
          vendor:     li.vendor,
          confidence: r.confidence,
          learnedBy:  "ai_cron",
          learnedAt:  now,
          source:     "ai_cron",
        }));
        newPriceRows.push(shapes.makePriceRow({
          itemId:      r.matchedItemId,
          account:     accountTab,
          vendor:      li.vendor,
          price:       r.normalizedPrice || li.unitPrice,
          invoiceDate: li.invoiceDate,
          invoiceUuid: li.invoiceUuid,
          recordedAt:  now,
        }));
      } else {
        // Low confidence → queue for review
        queued++;
        maybePushQueueRow(shapes.makeQueueRow({
          queueId:            `q_${uid()}`,
          lineItemText:       li.description,
          vendor:             li.vendor,
          invoiceUuid:        li.invoiceUuid,
          invoiceDate:        li.invoiceDate,
          account:            accountTab,
          suggestedMatchId:   r.matchedItemId,
          suggestedMatchName: r.canonicalName || "",
          confidence:         r.confidence,
          status:             "pending",
          reserved10:         "",
          reserved11:         "",
          reserved12:         "",
          reason:             "low_match_confidence",
        }));
      }
    }

    if (r.action === "new") {
      if (r.confidence !== undefined && r.confidence >= 60) {
        // Actually a possible match that should be reviewed
        queued++;
        maybePushQueueRow(shapes.makeQueueRow({
          queueId:            `q_${uid()}`,
          lineItemText:       li.description,
          vendor:             li.vendor,
          invoiceUuid:        li.invoiceUuid,
          invoiceDate:        li.invoiceDate,
          account:            accountTab,
          suggestedMatchId:   r.matchedItemId || "",
          suggestedMatchName: r.canonicalName || "",
          confidence:         r.confidence || 0,
          status:             "pending",
          reserved10:         "",
          reserved11:         "",
          reserved12:         "",
          reason:             "possible_new",
        }));
      } else {
        // Genuinely new item → create catalog entry
        created++;
        const itemId = `item_${uid()}`;
        batchNewIds[r.index] = itemId; // Track for batch_match resolution
        newCatalogRows.push(shapes.makeCatalogRow({
          itemId:           itemId,
          account:          accountTab,
          name:             r.canonicalName || li.description,
          category:         r.category || "Food",
          unit:             r.unit || li.unit || "EA",
          storage:          r.suggestedStorage || "dry",
          vendor:           li.vendor,
          price:            r.normalizedPrice || li.unitPrice,
          invoiceDate:      li.invoiceDate,
          vendor2:          li.vendor,
          priceAtLastCount: "",
          active:           "TRUE",
          linkedToInvoice:  "TRUE",
          isVariety:        r.isVarietyOf ? "TRUE" : "FALSE",
          createdBy:        "ai_cron",
          createdAt:        now,
          updatedAt:        now,
        }));
        // Also add the original description as an alias
        newAliasRows.push(shapes.makeAliasRow({
          aliasId:    `alias_${uid()}`,
          aliasText:  li.description,
          itemId:     itemId,
          vendor:     li.vendor,
          confidence: 100,
          learnedBy:  "ai_cron",
          learnedAt:  now,
          source:     "ai_cron",
        }));
        newPriceRows.push(shapes.makePriceRow({
          itemId:      itemId,
          account:     accountTab,
          vendor:      li.vendor,
          price:       r.normalizedPrice || li.unitPrice,
          invoiceDate: li.invoiceDate,
          invoiceUuid: li.invoiceUuid,
          recordedAt:  now,
        }));
      }
    }

    if (r.action === "batch_match") {
      // This item is the same product as another "new" item in this batch
      const refIndex = r.batchRefIndex;
      const refItemId = batchNewIds[refIndex];
      if (refItemId) {
        // Treat like a match — add alias + price history pointing to the batch-created item
        matched++;
        newAliasRows.push(shapes.makeAliasRow({
          aliasId:    `alias_${uid()}`,
          aliasText:  li.description,
          itemId:     refItemId,
          vendor:     li.vendor,
          confidence: 100,
          learnedBy:  "ai_cron_batch",
          learnedAt:  now,
          source:     "ai_cron",
        }));
        newPriceRows.push(shapes.makePriceRow({
          itemId:      refItemId,
          account:     accountTab,
          vendor:      li.vendor,
          price:       r.normalizedPrice || li.unitPrice,
          invoiceDate: li.invoiceDate,
          invoiceUuid: li.invoiceUuid,
          recordedAt:  now,
        }));
      } else {
        // Reference not found (edge case) — create as new to avoid data loss
        console.warn(`[${accountTab}] batch_match ref ${refIndex} not found for index ${r.index}, creating as new`);
        created++;
        const itemId = `item_${uid()}`;
        batchNewIds[r.index] = itemId;
        newCatalogRows.push(shapes.makeCatalogRow({
          itemId:           itemId,
          account:          accountTab,
          name:             r.canonicalName || li.description,
          category:         r.category || "Food",
          unit:             r.unit || li.unit || "EA",
          storage:          r.suggestedStorage || "dry",
          vendor:           li.vendor,
          price:            r.normalizedPrice || li.unitPrice,
          invoiceDate:      li.invoiceDate,
          vendor2:          li.vendor,
          priceAtLastCount: "",
          active:           "TRUE",
          linkedToInvoice:  "TRUE",
          isVariety:        r.isVarietyOf ? "TRUE" : "FALSE",
          createdBy:        "ai_cron",
          createdAt:        now,
          updatedAt:        now,
        }));
        newAliasRows.push(shapes.makeAliasRow({
          aliasId:    `alias_${uid()}`,
          aliasText:  li.description,
          itemId:     itemId,
          vendor:     li.vendor,
          confidence: 100,
          learnedBy:  "ai_cron",
          learnedAt:  now,
          source:     "ai_cron",
        }));
        newPriceRows.push(shapes.makePriceRow({
          itemId:      itemId,
          account:     accountTab,
          vendor:      li.vendor,
          price:       r.normalizedPrice || li.unitPrice,
          invoiceDate: li.invoiceDate,
          invoiceUuid: li.invoiceUuid,
          recordedAt:  now,
        }));
      }
    }
  }

  // 6. Write results — CRITICAL: use "tab!A1" range to prevent offset writes
  if (newCatalogRows.length) await appendRows(INVENTORY_SHEET_ID, "item_catalog!A1", newCatalogRows);
  if (newAliasRows.length) await appendRows(INVENTORY_SHEET_ID, "item_aliases!A1", newAliasRows);
  if (newPriceRows.length) await appendRows(INVENTORY_SHEET_ID, "price_history!A1", newPriceRows);
  if (newQueueRows.length) await appendRows(INVENTORY_SHEET_ID, "review_queue!A1", newQueueRows);

  // PR 6 (durable catch-weight log): append the collected detections to the
  // catchweight_derivations_log tab. Non-blocking - if the tab doesn't exist
  // yet or the append fails for any reason, log + continue. Cron's primary
  // job (matching + queueing) must not be held up by the auxiliary log.
  //
  // Schema (14 cols): A timestamp | B account | C vendor | D invoiceUuid |
  // E invoiceNumber | F lineDescription | G oldQty | H oldUnit | I derivedQty |
  // J derivedUnit | K unitPrice | L amount | M derivationReason | N cronMode
  //
  // First-run setup: Kevin creates the tab manually with the header row above.
  // If the tab doesn't exist, this block logs the failure and continues; the
  // log writes start landing as soon as the tab exists.
  if (catchWeightDetections.length > 0) {
    try {
      const rows = catchWeightDetections.map((d) => [
        d.timestamp, d.account, d.vendor, d.invoiceUuid, d.invoiceNumber,
        d.description, d.oldQty, d.oldUnit, d.derivedQty, d.derivedUnit,
        d.unitPrice, d.amount, d.derivationReason, d.cronMode,
      ]);
      await appendRows(INVENTORY_SHEET_ID, "catchweight_derivations_log!A1", rows);
      console.log(`[${accountTab}] [catchweight-log] appended ${rows.length} catch_weight_subline detection(s)`);
    } catch (e) {
      console.warn(`[${accountTab}] [catchweight-log] append failed (non-blocking): ${e.message}`);
    }
  }

  const summary = { account: accountTab, processed: newItems.length, matched, created, queued, held, skipped, invoiceHoldsHonored, linesDeferredByHold, creditsSkipped, linesSkippedByCredit };

  // PR 3: attach the shadow tally + samples to the per-account summary so
  // main()'s digest aggregator can roll them up. Only present in shadow
  // mode (live + off skip the bucket math).
  if (DERIVATION_MODE === "shadow") {
    summary.derivationShadow = {
      tally: derivationTally,
      byVendor: Object.fromEntries(derivationByVendor),
      wouldRecoverSamples,
      wouldRegressSamples,
    };
    // Also log the per-account summary line for Railway log grep. Lets Kevin
    // pull the full sample set from logs even if Slack message gets clipped.
    const t = derivationTally;
    console.log(`[${accountTab}] [derivation-shadow] would-recover=${t.wouldRecover}, would-regress=${t.wouldRegress}, no-change=${t.noChange}, residual=${t.residual}`);
    for (const s of wouldRecoverSamples) {
      console.log(`[${accountTab}] [derivation-shadow-sample-recover] ${JSON.stringify(s)}`);
    }
    for (const s of wouldRegressSamples) {
      console.log(`[${accountTab}] [derivation-shadow-sample-regress] ${JSON.stringify(s)}`);
    }
  }

  // PR A: attach review-queue-respect tally to the per-account summary.
  // Present in both shadow and live modes (so live can report actual
  // skip/suppress counts the same way shadow reported would-counts).
  if (REVIEW_QUEUE_RESPECT_MODE !== "off") {
    summary.reviewQueueRespect = {
      mode: REVIEW_QUEUE_RESPECT_MODE,
      resolvedInvoiceCount: resolvedRespectInvoiceCount,
      resolvedLineCount: resolvedRespectLineCount,
      reQueueSuppressed,
      pendingQueueKeysSize: pendingQueueKeys.size,    // diagnostic: how many "pending" rows already in the queue for this account
      resolvedInvoiceUuidsSize: resolvedInvoiceUuids.size,
    };
    console.log(`[${accountTab}] [review-queue-respect/${REVIEW_QUEUE_RESPECT_MODE}] resolvedInvoices=${resolvedRespectInvoiceCount}, resolvedLines=${resolvedRespectLineCount}, reQueueSuppressed=${reQueueSuppressed}, pendingKeys=${pendingQueueKeys.size}, resolvedUuids=${resolvedInvoiceUuids.size}`);
  }

  // PR 8.3 dry-run: transform the Sheets row arrays into PG row shape,
  // compute the dedup divergence, attach the per-account diff to the
  // summary so main() can post the aggregate digest. Writes NOTHING to PG.
  if (pgCtx) {
    try {
      const { rows: pgRows, skips } = pgCtx.module.buildPGRowArrays(pgCtx, {
        catalog: newCatalogRows,
        aliases: newAliasRows,
        prices:  newPriceRows,
        queue:   newQueueRows,
      });
      const divergence = pgCtx.module.computeDedupDivergence(sheetsProcessedInvoices, pgProcessedInvoices);
      summary.pgDryRun = {
        account: accountTab,
        would: {
          catalog: pgRows.catalog.length,
          aliases: pgRows.aliases.length,
          prices:  pgRows.prices.length,
          queue:   pgRows.queue.length,
        },
        skips: {
          totalRowsSkipped: skips.totalRowsSkipped,
          categoryInvalid: skips.categoryInvalid,
          vendorUnresolved: skips.vendorUnresolved,
        },
        divergence,
      };
      console.log(`[${accountTab}] PG dry-run diff:`);
      console.log(`  would write to PG: ${pgRows.catalog.length}c / ${pgRows.aliases.length}a / ${pgRows.prices.length}p / ${pgRows.queue.length}q`);
      if (skips.totalRowsSkipped > 0) {
        const vendors = [...skips.vendorUnresolved.keys()];
        console.log(`  skipped ${skips.totalRowsSkipped} row(s) for ${vendors.length} unresolved vendor(s): ${vendors.slice(0, 5).map((v) => `"${v}"`).join(", ")}${vendors.length > 5 ? ` (+${vendors.length - 5} more)` : ""}`);
      }
      if (skips.categoryInvalid > 0) {
        console.log(`  ${skips.categoryInvalid} catalog row(s) had category sanitized to NULL (unmapped value)`);
      }
      console.log(`  dedup divergence: Sheets=${divergence.sheetsCount}, PG=${divergence.pgCount}, S-only=${divergence.sheetsOnly}, P-only=${divergence.pgOnly}`);
    } catch (e) {
      console.error(`[${accountTab}] [pg-dry-run] diff build failed:`, e.message);
      summary.pgDryRun = { account: accountTab, error: e.message };
    }
  }

  console.log(`[${accountTab}] Done:`, JSON.stringify({ ...summary, pgDryRun: summary.pgDryRun ? "(see above)" : undefined }));
  return summary;
}

// ── PR 3: Slack section for the catch-weight derivation shadow ──
// Aggregates per-account shadow tallies, sorts the per-vendor would-recover
// breakdown by recovery count, and pastes auditable samples for spot-checking
// against the actual invoices (Kevin's "verify the recovered quantity is
// genuinely correct, not just arithmetically footing" requirement).
//
// Sample budget: up to GLOBAL_SAMPLE_CAP per bucket in Slack. Full per-account
// samples are also written to console.log via processAccount so Railway log
// grep can pull the unbounded set if Slack clips. Returns empty string when
// shadow data is absent (off / live).
// PR A: Slack section for review-queue-respect (shadow or live). Reports
// per-account counts of: (a) resolved invoices the cron would skip / did
// skip on this run, and (b) duplicate re-queue appends suppressed.
// Returns empty string when no per-account result carries the tally.
function buildReviewQueueRespectSection(results) {
  const tallied = results.filter((r) => r.reviewQueueRespect);
  if (tallied.length === 0) return "";

  // Mode is per-account but env-driven so identical across accounts; pick
  // the first to label the digest heading.
  const mode = tallied[0].reviewQueueRespect.mode;

  let totalResolvedInvoices = 0;
  let totalResolvedLines    = 0;
  let totalReQueueSuppressed = 0;
  const byAccount = [];
  for (const r of tallied) {
    const t = r.reviewQueueRespect;
    totalResolvedInvoices  += t.resolvedInvoiceCount;
    totalResolvedLines     += t.resolvedLineCount;
    totalReQueueSuppressed += t.reQueueSuppressed;
    if (t.resolvedInvoiceCount + t.reQueueSuppressed > 0) {
      byAccount.push({ account: r.account, ...t });
    }
  }

  // Sort by activity desc so the noisy accounts surface first.
  byAccount.sort((a, b) =>
    (b.resolvedInvoiceCount + b.reQueueSuppressed) -
    (a.resolvedInvoiceCount + a.reQueueSuppressed)
  );

  const verbResolved   = mode === "live" ? "skipped"   : "WOULD skip";
  const verbSuppressed = mode === "live" ? "suppressed" : "WOULD suppress";
  const heading = mode === "live"
    ? `\n*🔁 Review-queue respect* (CRON_REVIEW_QUEUE_RESPECT=live)\n`
    : `\n*🔁 Review-queue respect shadow* (CRON_REVIEW_QUEUE_RESPECT=shadow)\n`;

  let text = heading;
  text += `   resolved-status respect: ${verbResolved} ${totalResolvedInvoices} resolved invoice(s), ${totalResolvedLines} line(s)\n`;
  text += `   re-queue dedup guard:    ${verbSuppressed} ${totalReQueueSuppressed} duplicate append(s)\n`;
  if (byAccount.length > 0) {
    text += `   per-account (only accounts with activity):\n`;
    for (const a of byAccount) {
      const bits = [];
      if (a.resolvedInvoiceCount > 0) bits.push(`${a.resolvedInvoiceCount} resolved inv (${a.resolvedLineCount} line)`);
      if (a.reQueueSuppressed > 0)    bits.push(`${a.reQueueSuppressed} dup re-queue`);
      text += `      ${a.account}: ${bits.join(", ")}\n`;
    }
  } else {
    text += `   (no activity this run - foundation in place, waiting for PR B's resolve actions to start producing non-pending rows)\n`;
  }
  return text;
}

function buildDerivationShadowSection(results) {
  const shadowResults = results.filter((r) => r.derivationShadow);
  if (shadowResults.length === 0) return "";

  const GLOBAL_SAMPLE_CAP = 15;
  const total = { wouldRecover: 0, wouldRegress: 0, noChange: 0, residual: 0 };
  const byVendor = new Map();
  let allRecover = [];
  let allRegress = [];
  for (const r of shadowResults) {
    const s = r.derivationShadow;
    for (const k of ["wouldRecover", "wouldRegress", "noChange", "residual"]) total[k] += s.tally[k];
    for (const [v, t] of Object.entries(s.byVendor)) {
      if (!byVendor.has(v)) byVendor.set(v, { wouldRecover: 0, wouldRegress: 0, noChange: 0, residual: 0 });
      const b = byVendor.get(v);
      for (const k of ["wouldRecover", "wouldRegress", "noChange", "residual"]) b[k] += t[k];
    }
    allRecover = allRecover.concat(s.wouldRecoverSamples);
    allRegress = allRegress.concat(s.wouldRegressSamples);
  }

  let text = `\n*🧪 Catch-weight derivation shadow* (CRON_USE_DERIVATION=shadow)\n`;
  text += `   would-recover: ${total.wouldRecover} line(s)`;
  if (total.wouldRecover > 0) {
    const vendorList = [...byVendor.entries()]
      .filter(([_v, t]) => t.wouldRecover > 0)
      .sort((a, b) => b[1].wouldRecover - a[1].wouldRecover);
    text += ` across ${vendorList.length} vendor(s):\n`;
    for (const [v, t] of vendorList) text += `      ${v}: ${t.wouldRecover}\n`;
  } else {
    text += `\n`;
  }
  text += `   would-regress: ${total.wouldRegress} line(s) ${total.wouldRegress > 0 ? "⚠️ ALARM, investigate before live cutover" : ""}\n`;
  text += `   no-change: ${total.noChange} line(s)\n`;
  text += `   residual (still FAIL after derivation): ${total.residual} line(s) ← review-queue floor\n`;

  if (allRecover.length > 0) {
    text += `\n   *Would-recover samples (verify against invoices):*\n`;
    const samples = allRecover.slice(0, GLOBAL_SAMPLE_CAP);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const desc = String(s.description || "").slice(0, 40);
      const recompute = (Number(s.newQty) * Number(s.unitPrice)).toFixed(2);
      text += `   ${i + 1}. \`${s.vendor || "?"}\` #${s.invoiceNumber || "?"} "${desc}"\n`;
      text += `      old qty=${s.oldQty} ${s.oldUnit || ""} -> new qty=${s.newQty} ${s.newUnit || ""} (${s.derivedReason})\n`;
      text += `      unitPrice=$${s.unitPrice}, amount=$${s.amount}, ${s.newQty}×${s.unitPrice}=${recompute}\n`;
    }
    if (allRecover.length > GLOBAL_SAMPLE_CAP) {
      text += `   (+${allRecover.length - GLOBAL_SAMPLE_CAP} more samples in Railway logs: grep "derivation-shadow-sample-recover")\n`;
    }
  }
  if (allRegress.length > 0) {
    text += `\n   *Would-regress samples* ⚠️ *(alarm, investigate):*\n`;
    const samples = allRegress.slice(0, GLOBAL_SAMPLE_CAP);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const desc = String(s.description || "").slice(0, 40);
      text += `   ${i + 1}. \`${s.vendor || "?"}\` #${s.invoiceNumber || "?"} "${desc}"\n`;
      text += `      old qty=${s.oldQty} (gate PASS) -> new qty=${s.newQty}/${s.derivedGateResult} (${s.derivedReason})\n`;
      text += `      unitPrice=$${s.unitPrice}, amount=$${s.amount}\n`;
    }
    if (allRegress.length > GLOBAL_SAMPLE_CAP) {
      text += `   (+${allRegress.length - GLOBAL_SAMPLE_CAP} more regression samples in Railway logs: grep "derivation-shadow-sample-regress")\n`;
    }
  }
  return text;
}

// ── Slack Digest (Mondays) ──
async function postSlackDigest(results) {
  if (!SLACK_RECAP_WEBHOOK) return;
  const isMonday = new Date().getDay() === 1;
  if (!isMonday && results.every((r) => r.processed === 0)) return;

  // Read current review queue for health summary
  const queueRows = await readTab(INVENTORY_SHEET_ID, "review_queue");
  const pendingByAccount = {};
  queueRows.filter((r) => r[9] === "pending").forEach((r) => {
    const acct = r[5] || "Unknown";
    pendingByAccount[acct] = (pendingByAccount[acct] || 0) + 1;
  });

  let text = "*🔄 Inventory Cron — Nightly Run*\n";
  let totalHeld = 0;
  let totalInvoiceHolds = 0, totalLinesDeferred = 0;
  let totalCredits = 0, totalLinesByCredit = 0;
  for (const r of results) {
    if (r.processed > 0 || r.error || r.linesDeferredByHold || r.linesSkippedByCredit) {
      const heldPart = r.held ? `, ${r.held} held` : "";
      const deferredPart = r.linesDeferredByHold ? `, ${r.linesDeferredByHold} deferred (${r.invoiceHoldsHonored} held invoice${r.invoiceHoldsHonored === 1 ? "" : "s"})` : "";
      const creditPart = r.linesSkippedByCredit ? `, ${r.linesSkippedByCredit} credit-skipped (${r.creditsSkipped} credit memo${r.creditsSkipped === 1 ? "" : "s"})` : "";
      text += `• *${r.account}*: ${r.matched} matched, ${r.created} new, ${r.queued} queued${heldPart}${deferredPart}${creditPart}, ${r.skipped} skipped`;
      if (r.error) text += ` ⚠️ ${r.error}`;
      text += "\n";
      totalHeld += r.held || 0;
      totalInvoiceHolds += r.invoiceHoldsHonored || 0;
      totalLinesDeferred += r.linesDeferredByHold || 0;
      totalCredits += r.creditsSkipped || 0;
      totalLinesByCredit += r.linesSkippedByCredit || 0;
    }
  }
  if (totalHeld > 0) {
    text += `\n*⚠️ ${totalHeld} line(s) held by arithmetic gate (reason="arithmetic_fail" in review_queue)*\n`;
  }
  if (totalInvoiceHolds > 0) {
    text += `*⏸ ${totalInvoiceHolds} invoice(s) deferred entirely (${totalLinesDeferred} line(s)) by overcount_suspect_reextract flag*\n`;
  }
  if (totalCredits > 0) {
    text += `*🧾 ${totalCredits} credit memo(s) skipped (${totalLinesByCredit} line(s)) — extracted to ai_line_items for finance, not fed to inventory*\n`;
  }

  // PR 3: catch-weight derivation shadow section (fires only when shadow data
  // is attached to per-account results, i.e. CRON_USE_DERIVATION=shadow).
  text += buildDerivationShadowSection(results);
  text += buildReviewQueueRespectSection(results);

  if (isMonday) {
    text += "\n*📋 Weekly Catalog Health:*\n";
    const accounts = Object.keys(pendingByAccount);
    if (accounts.length === 0) {
      text += "All accounts healthy — 0 items need review.\n";
    } else {
      for (const acct of accounts) {
        text += `• ${acct}: ${pendingByAccount[acct]} unmatched\n`;
      }
    }
  }

  try {
    await fetch(SLACK_RECAP_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    console.log("[Slack] Digest posted.");
  } catch (e) {
    console.error("[Slack] Post failed:", e.message);
  }
}

// ═══════════════════════════════════════
// ONE-TIME CATALOG DEDUP
// Run with: DEDUP=1 node index.js
// ═══════════════════════════════════════
async function dedupExistingCatalog() {
  console.log("=== Catalog Dedup ===");

  const [catalogRows, aliasRows, priceRows] = await Promise.all([
    readTab(INVENTORY_SHEET_ID, "item_catalog"),
    readTab(INVENTORY_SHEET_ID, "item_aliases"),
    readTab(INVENTORY_SHEET_ID, "price_history"),
  ]);

  // Group active items by normalized name + account
  const groups = {};
  catalogRows.forEach((r, i) => {
    if (r[11] === "FALSE" || r[11] === false) return; // skip inactive
    const account = r[1] || "";
    const name = normalizeName(r[2]);
    const key = `${account}::${name}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ row: r, rowNum: i + 2, itemId: r[0], name: r[2], lastPriceDate: r[8] || "", locationId: r[5] || "" });
  });

  let deactivated = 0;
  const ops = [];

  for (const [key, items] of Object.entries(groups)) {
    if (items.length <= 1) continue;

    // Keep the item with the most recent price date, or the one with a locationId
    items.sort((a, b) => {
      // Prefer item with locationId
      if (a.locationId && !b.locationId) return -1;
      if (!a.locationId && b.locationId) return 1;
      // Then by most recent price date
      return (b.lastPriceDate || "").localeCompare(a.lastPriceDate || "");
    });
    const keeper = items[0];
    const dupes = items.slice(1);

    console.log(`Dedup: "${keeper.name}" — keeping ${keeper.itemId} (row ${keeper.rowNum}), deactivating ${dupes.length} dupe(s)`);

    for (const dupe of dupes) {
      // Deactivate the dupe (column L = "FALSE")
      ops.push({ range: `item_catalog!L${dupe.rowNum}`, values: [["FALSE"]] });

      // Remap aliases pointing to dupe → keeper
      aliasRows.forEach((a, ai) => {
        if (a[2] === dupe.itemId) {
          ops.push({ range: `item_aliases!C${ai + 2}`, values: [[keeper.itemId]] });
        }
      });

      // Remap price_history rows → keeper itemId
      priceRows.forEach((p, pi) => {
        if (p[0] === dupe.itemId) {
          ops.push({ range: `price_history!A${pi + 2}`, values: [[keeper.itemId]] });
        }
      });

      // If dupe had a locationId and keeper doesn't, copy it
      if (dupe.locationId && !keeper.locationId) {
        ops.push({ range: `item_catalog!F${keeper.rowNum}`, values: [[dupe.locationId]] });
        keeper.locationId = dupe.locationId; // update in memory for subsequent dupes
      }

      deactivated++;
    }
  }

  console.log(`\nWould deactivate ${deactivated} duplicate items across ${ops.length} cell updates.`);

  if (process.env.DEDUP_DRY_RUN !== "false") {
    console.log("DRY RUN — no changes written. Set DEDUP_DRY_RUN=false to execute.");
    return { deactivated, operations: ops.length, dryRun: true };
  }

  // Execute updates
  console.log("Writing updates...");
  let written = 0;
  for (const op of ops) {
    await updateRange(INVENTORY_SHEET_ID, op.range, op.values);
    written++;
    if (written % 50 === 0) console.log(`  ${written}/${ops.length} updates written...`);
  }
  console.log(`Done. ${deactivated} duplicates deactivated, ${written} cells updated.`);
  return { deactivated, operations: written, dryRun: false };
}

// ── Main ──
async function main() {
  // Check for dedup mode
  if (process.env.DEDUP === "1") {
    await dedupExistingCatalog();
    return;
  }

  console.log("=== KitchFix Inventory Cron ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Threshold: ${MATCH_CONFIDENCE_THRESHOLD}%`);

  // Validate env
  if (!INVENTORY_SHEET_ID || !AI_LINE_ITEMS_SHEET_ID || !ANTHROPIC_API_KEY) {
    console.error("Missing required env vars. Need: INVENTORY_SHEET_ID, AI_LINE_ITEMS_SHEET_ID, ANTHROPIC_API_KEY");
    process.exit(1);
  }
  if (!COLLECTION_SHEET_ID) {
    // Stage 0 credit filter requires COLLECTION_SHEET_ID. Warn once at startup
    // and continue without the filter (pre-Stage-0 behavior preserved).
    console.warn("[Stage 0] COLLECTION_SHEET_ID not set — credit filter disabled, all invoices (including type='credit') will be ingested into inventory as before.");
  }

  // Discover account tabs in AI_LINE_ITEMS
  const allTabs = await getTabNames(AI_LINE_ITEMS_SHEET_ID);
  // Filter out metadata tabs
  const skipTabs = new Set(["Invoice Uploads", "Sheet1", "_metadata"]);
  const accountTabs = allTabs.filter((t) => !skipTabs.has(t) && !t.startsWith("_"));

  console.log(`Found ${accountTabs.length} account tabs: ${accountTabs.join(", ")}`);

  // PR 3: log the active derivation mode so Railway logs show which path
  // the cron took without needing the env var page.
  if (DERIVATION_MODE !== "off") {
    console.log(`\n[derivation] CRON_USE_DERIVATION=${DERIVATION_MODE}: catch-weight derivation active (${DERIVATION_MODE === "shadow" ? "tallies only, NO live behavior change" : "LIVE: gate + price_history use derived quantity"})`);
  }
  if (REVIEW_QUEUE_RESPECT_MODE !== "off") {
    console.log(`\n[review-queue-respect] CRON_REVIEW_QUEUE_RESPECT=${REVIEW_QUEUE_RESPECT_MODE}: ${REVIEW_QUEUE_RESPECT_MODE === "shadow" ? "tallies only, NO live behavior change" : "LIVE: resolved-status invoices skipped + duplicate re-queue appends suppressed"}`);
  }

  // PR 8.3: PG dry-run context (only when CRON_USE_POSTGRES === "dry-run").
  // Initialized once per cron run; reused for all per-account passes.
  let pgCtx = null;
  if (CRON_USE_POSTGRES === "dry-run") {
    console.log(`\n[pg-dry-run] CRON_USE_POSTGRES=dry-run — PG reads + transforms enabled; NO PG writes will be performed`);
    try {
      const pgMod = await import("./pg-dry-run.mjs");
      pgCtx = await pgMod.initPGDryRunContext({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
      });
      pgCtx.module = pgMod;
      console.log(`[pg-dry-run] context ready: ${pgCtx.vendorMaps.nameToVendorId.size} vendor names + ${pgCtx.vendorMaps.aliasNormToVendorId.size} aliases loaded`);
    } catch (e) {
      console.error(`[pg-dry-run] initialization failed (cron continues without PG dry-run):`, e.message);
      pgCtx = null;
    }
  }

  // Process each account
  const results = [];
  for (const tab of accountTabs) {
    try {
      const result = await processAccount(tab, pgCtx);
      results.push(result);
    } catch (e) {
      console.error(`[${tab}] Fatal error:`, e.message);
      results.push({ account: tab, processed: 0, error: e.message });
    }
    // Small delay between accounts to avoid rate limits
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Post Slack digest
  await postSlackDigest(results);

  // PR 8.3 dry-run: aggregate per-account diffs and post the dry-run digest
  // separately from the (Monday-conditional) catalog digest. Runs every
  // cron pass when CRON_USE_POSTGRES=dry-run.
  if (pgCtx) {
    const dryRunDiffs = results
      .map((r) => r.pgDryRun)
      .filter((d) => d != null);
    await pgCtx.module.postPGDryRunDigest(SLACK_RECAP_WEBHOOK, dryRunDiffs);
  }

  console.log("\n=== Cron Complete ===");
  const totalProcessed = results.reduce((s, r) => s + (r.processed || 0), 0);
  const totalCreated = results.reduce((s, r) => s + (r.created || 0), 0);
  const totalMatched = results.reduce((s, r) => s + (r.matched || 0), 0);
  console.log(`Total: ${totalProcessed} processed, ${totalMatched} matched, ${totalCreated} created`);

  // ── Reconciliation alarm (D10 safety net) ──
  // Runs as the tail of the cron pass so every cron-side write is visible
  // to the comparison. Failures here LOG but do NOT change the cron's
  // exit code — the cron's own work succeeded regardless of whether the
  // alarm can post its digest. Requires SUPABASE_URL +
  // SUPABASE_SERVICE_ROLE_KEY + DUAL_WRITE_TABLES on top of the env vars
  // the cron already uses (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
  // SLACK_RECAP_WEBHOOK reused).
  try {
    console.log("\n=== Reconciliation Alarm ===");
    const { runReconciliationAlarm } = await import("./reconciliation-alarm.mjs");
    const result = await runReconciliationAlarm();
    console.log(`[recon-alarm] complete; alarm=${result.alarm}`);
  } catch (e) {
    console.error("[recon-alarm] failed (cron exit unaffected):", e.message);
  }
}

main().catch((e) => {
  console.error("Cron failed:", e);
  process.exit(1);
});