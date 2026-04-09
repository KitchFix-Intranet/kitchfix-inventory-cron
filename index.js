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
 * v1.1 — Dedup fixes:
 *   - Prompt: tightened matching rules + batch_match action for intra-batch dedup
 *   - Code: post-process results to catch duplicate "new" entries Claude missed
 *   - Code: sort results so "new" processes before "batch_match"
 *   - Added: dedupExistingCatalog() one-time cleanup function
 */

const { google } = require("googleapis");

// ── Config ──
const INVENTORY_SHEET_ID = process.env.INVENTORY_SHEET_ID;
const AI_LINE_ITEMS_SHEET_ID = process.env.AI_LINE_ITEMS_SHEET_ID;
const HUB_SHEET_ID = process.env.HUB_SHEET_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MATCH_CONFIDENCE_THRESHOLD = parseInt(process.env.MATCH_CONFIDENCE_THRESHOLD || "90");
const SLACK_RECAP_WEBHOOK = process.env.SLACK_RECAP_WEBHOOK;

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

// ── Sheet Helpers ──
async function readTab(spreadsheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabName });
    const data = res.data.values || [];
    if (data.length <= 1) return []; // header only or empty
    return data.slice(1); // skip header
  } catch (e) {
    console.warn(`[read] ${tabName}: ${e.message}`);
    return [];
  }
}

async function appendRows(spreadsheetId, tabName, rows) {
  if (!rows.length) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: tabName,
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
async function processAccount(accountTab) {
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
  }));

  // 2. Read existing catalog + aliases + price_history for this account
  const [catalogRows, aliasRows, priceRows] = await Promise.all([
    readTab(INVENTORY_SHEET_ID, "item_catalog"),
    readTab(INVENTORY_SHEET_ID, "item_aliases"),
    readTab(INVENTORY_SHEET_ID, "price_history"),
  ]);

  const catalog = catalogRows
    .filter((r) => r[1] === accountTab && r[11] !== "FALSE")
    .map((r) => ({
      itemId: r[0], name: r[2], category: r[3], unit: r[4],
      locationId: r[5], primaryVendor: r[6], lastPrice: r[7],
    }));

  const aliases = aliasRows
    .filter((r) => catalog.some((c) => c.itemId === r[2]))
    .map((r) => ({ aliasId: r[0], aliasText: r[1], canonicalItemId: r[2], vendor: r[3] }));

  // 3. Filter to unprocessed items — skip if invoiceUuid already in price_history
  const processedInvoices = new Set(
    priceRows.filter((r) => r[1] === accountTab).map((r) => r[5]) // invoiceId
  );

  const newItems = lineItems.filter((li) => !processedInvoices.has(li.invoiceUuid));

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
  let matched = 0, created = 0, queued = 0, skipped = 0;

  for (const r of results) {
    const li = newItems[r.index];
    if (!li) continue;

    if (r.action === "skip") {
      skipped++;
      continue;
    }

    if (r.action === "match" && r.matchedItemId) {
      if (r.confidence >= MATCH_CONFIDENCE_THRESHOLD) {
        // Auto-approve: add alias + update price
        matched++;
        newAliasRows.push([
          `alias_${uid()}`, li.description, r.matchedItemId,
          li.vendor, r.confidence, "ai_cron", now, "ai_cron",
        ]);
        newPriceRows.push([
          r.matchedItemId, accountTab, li.vendor,
          r.normalizedPrice || li.unitPrice, li.invoiceDate, li.invoiceUuid, now,
        ]);
      } else {
        // Low confidence → queue for review
        queued++;
        newQueueRows.push([
          `q_${uid()}`, li.description, li.vendor, li.invoiceUuid,
          li.invoiceDate, accountTab, r.matchedItemId,
          r.canonicalName || "", r.confidence, "pending", "", "", "",
        ]);
      }
    }

    if (r.action === "new") {
      if (r.confidence !== undefined && r.confidence >= 60) {
        // Actually a possible match that should be reviewed
        queued++;
        newQueueRows.push([
          `q_${uid()}`, li.description, li.vendor, li.invoiceUuid,
          li.invoiceDate, accountTab, r.matchedItemId || "",
          r.canonicalName || "", r.confidence || 0, "pending", "", "", "",
        ]);
      } else {
        // Genuinely new item → create catalog entry
        created++;
        const itemId = `item_${uid()}`;
        batchNewIds[r.index] = itemId; // Track for batch_match resolution
        newCatalogRows.push([
          itemId, accountTab, r.canonicalName || li.description,
          r.category || "Food", r.unit || li.unit || "EA",
          r.suggestedStorage || "dry", // AI-suggested storage keyword
          li.vendor, r.normalizedPrice || li.unitPrice,
          li.invoiceDate, li.vendor, "", // priceAtLastCount
          "TRUE", // active
          "TRUE", // linkedToInvoice
          r.isVarietyOf ? "TRUE" : "FALSE", // isVarietyGroup
          "ai_cron", now, now,
        ]);
        // Also add the original description as an alias
        newAliasRows.push([
          `alias_${uid()}`, li.description, itemId,
          li.vendor, 100, "ai_cron", now, "ai_cron",
        ]);
        newPriceRows.push([
          itemId, accountTab, li.vendor,
          r.normalizedPrice || li.unitPrice, li.invoiceDate, li.invoiceUuid, now,
        ]);
      }
    }

    if (r.action === "batch_match") {
      // This item is the same product as another "new" item in this batch
      const refIndex = r.batchRefIndex;
      const refItemId = batchNewIds[refIndex];
      if (refItemId) {
        // Treat like a match — add alias + price history pointing to the batch-created item
        matched++;
        newAliasRows.push([
          `alias_${uid()}`, li.description, refItemId,
          li.vendor, 100, "ai_cron_batch", now, "ai_cron",
        ]);
        newPriceRows.push([
          refItemId, accountTab, li.vendor,
          r.normalizedPrice || li.unitPrice, li.invoiceDate, li.invoiceUuid, now,
        ]);
      } else {
        // Reference not found (edge case) — create as new to avoid data loss
        console.warn(`[${accountTab}] batch_match ref ${refIndex} not found for index ${r.index}, creating as new`);
        created++;
        const itemId = `item_${uid()}`;
        batchNewIds[r.index] = itemId;
        newCatalogRows.push([
          itemId, accountTab, r.canonicalName || li.description,
          r.category || "Food", r.unit || li.unit || "EA",
          r.suggestedStorage || "dry",
          li.vendor, r.normalizedPrice || li.unitPrice,
          li.invoiceDate, li.vendor, "",
          "TRUE", "TRUE", r.isVarietyOf ? "TRUE" : "FALSE",
          "ai_cron", now, now,
        ]);
        newAliasRows.push([
          `alias_${uid()}`, li.description, itemId,
          li.vendor, 100, "ai_cron", now, "ai_cron",
        ]);
        newPriceRows.push([
          itemId, accountTab, li.vendor,
          r.normalizedPrice || li.unitPrice, li.invoiceDate, li.invoiceUuid, now,
        ]);
      }
    }
  }

  // 6. Write results
  if (newCatalogRows.length) await appendRows(INVENTORY_SHEET_ID, "item_catalog", newCatalogRows);
  if (newAliasRows.length) await appendRows(INVENTORY_SHEET_ID, "item_aliases", newAliasRows);
  if (newPriceRows.length) await appendRows(INVENTORY_SHEET_ID, "price_history", newPriceRows);
  if (newQueueRows.length) await appendRows(INVENTORY_SHEET_ID, "review_queue", newQueueRows);

  const summary = { account: accountTab, processed: newItems.length, matched, created, queued, skipped };
  console.log(`[${accountTab}] Done:`, JSON.stringify(summary));
  return summary;
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
  for (const r of results) {
    if (r.processed > 0 || r.error) {
      text += `• *${r.account}*: ${r.matched} matched, ${r.created} new, ${r.queued} queued, ${r.skipped} skipped`;
      if (r.error) text += ` ⚠️ ${r.error}`;
      text += "\n";
    }
  }

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
    if (r[11] === "FALSE") return; // skip inactive
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

  // Discover account tabs in AI_LINE_ITEMS
  const allTabs = await getTabNames(AI_LINE_ITEMS_SHEET_ID);
  // Filter out metadata tabs
  const skipTabs = new Set(["Invoice Uploads", "Sheet1", "_metadata"]);
  const accountTabs = allTabs.filter((t) => !skipTabs.has(t) && !t.startsWith("_"));

  console.log(`Found ${accountTabs.length} account tabs: ${accountTabs.join(", ")}`);

  // Process each account
  const results = [];
  for (const tab of accountTabs) {
    try {
      const result = await processAccount(tab);
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

  console.log("\n=== Cron Complete ===");
  const totalProcessed = results.reduce((s, r) => s + (r.processed || 0), 0);
  const totalCreated = results.reduce((s, r) => s + (r.created || 0), 0);
  const totalMatched = results.reduce((s, r) => s + (r.matched || 0), 0);
  console.log(`Total: ${totalProcessed} processed, ${totalMatched} matched, ${totalCreated} created`);
}

main().catch((e) => {
  console.error("Cron failed:", e);
  process.exit(1);
});