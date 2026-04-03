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

RESPOND WITH ONLY valid JSON (no markdown, no backticks, no explanation):
{
  "results": [
    {
      "index": 0,
      "action": "match" | "new" | "skip",
      "confidence": 95,
      "matchedItemId": "existing-item-id-if-matched",
      "canonicalName": "Clean Item Name",
      "category": "Food",
      "unit": "case",
      "normalizedPrice": 24.50,
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

  // 3. Filter to unprocessed items — skip if invoiceUuid+description already in price_history
  const processedKeys = new Set(
    priceRows.filter((r) => r[1] === accountTab).map((r) => `${r[5]}::${r[0]}`) // invoiceId::itemId
  );

  // For first run or new items: check which invoice UUIDs we haven't seen
  const processedInvoices = new Set(
    priceRows.filter((r) => r[1] === accountTab).map((r) => r[5]) // invoiceId
  );

  const newItems = lineItems.filter((li) => !processedInvoices.has(li.invoiceUuid));

  if (newItems.length === 0) {
    console.log(`[${accountTab}] All ${lineItems.length} items already processed.`);
    return { account: accountTab, processed: 0, matched: 0, created: 0, queued: 0, skipped: 0 };
  }

  console.log(`[${accountTab}] ${newItems.length} new items (${lineItems.length} total, ${catalog.length} in catalog)`);

  // 4. Call Claude
  const prompt = buildMatchPrompt(newItems, catalog, aliases);
  let results;
  try {
    const raw = await callClaude(prompt);
    const cleaned = raw.replace(/```json\s*|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    results = parsed.results || [];
  } catch (e) {
    console.error(`[${accountTab}] Claude error: ${e.message}`);
    return { account: accountTab, processed: newItems.length, matched: 0, created: 0, queued: 0, skipped: 0, error: e.message };
  }

  // 5. Process results
  const now = new Date().toISOString();
  const newCatalogRows = [];
  const newAliasRows = [];
  const newPriceRows = [];
  const newQueueRows = [];
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
        newCatalogRows.push([
          itemId, accountTab, r.canonicalName || li.description,
          r.category || "Food", r.unit || li.unit || "EA",
          "", // locationId — unassigned, EC will set
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

// ── Main ──
async function main() {
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
