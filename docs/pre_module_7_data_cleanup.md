# Pre-Module-7 Data Cleanup Backlog

**Status:** APPROVED IN PRINCIPLE. Items execute one at a time with show-me-before-delete approval gates. Bounded scope: clean PG before Module 7's backfill ships, so PG doesn't inherit duplicate/orphan rows that the cron migration would then propagate.

**Source:** the 2026-06-10 pipeline audit verified the dry-run boundary holds and surfaced 5 categories of duplicate/orphan data sitting in PG and Sheets. Module 7's review_queue/inventory_items/item_aliases/price_history backfill, as currently scoped, would import these as-is. This doc captures what must be addressed before that backfill ships.

This is NOT an audit-everything pass. The 6 items below are the verified findings. Each requires its own show-me-before-delete approval gate. None of them block today's work (the dashboard PR B and dup-submission Phase A can run alongside this backlog).

---

## Sequencing

This cleanup runs BEFORE Module 7's backfill PR (PR 7.3) ships. Module 7 has not started; the dashboard PR B and Phase A dup-submission work are interleaved alongside this backlog. The order within this backlog:

1. review_queue cleanup -- in flight, separate doc / PR
2. PG.inventory_items 87-group catalog dup -- TOP investigation item (the one unexplained finding)
3. PG.ai_line_items 41-group dup
4. PG.price_history 59-group dup
5. PG.invoice_submissions 25-group dup (overlap with dup-submission Phase B)
6. NULL-invoice_uuid ai_line_items (260 rows) decision
7. Sheets ai_line_items orphan invoiceUuids (145 distinct) decision

---

## Items

### 1. review_queue cleanup (in flight)

**Status:** preview approved 2026-06-10; execution pending Kevin's final go.

**Scope:** 1056 Sheets / 191 PG review_queue rows. Dedup key `(invoiceUuid, lineItemText)` audited safe (0 cross-account collisions, 50 within-group "suspicious" cases verified as chronic re-fires not distinct-line collisions). Canonical rule: status-aware (accepted > rejected > pending) + newest tie-break (Sheets: row index DESC; PG: created_at DESC).

**Delete preview:**
- Sheets: 1056 -> 379 (delete 677 across 63 dup groups, 14 deleteDimension chunks of 50)
- PG: 191 -> 167 (delete 24 via single `DELETE ... WHERE id IN (...)`)

**Tools:**
- `scripts/_probe_review_queue_cleanup_preview.mjs` (intranet, read-only)
- `scripts/_run_review_queue_cleanup.mjs --execute` (intranet, execute mode behind explicit flag)

**Post-execute verification:** re-run `scripts/_probe_pipeline_audit.mjs` and confirm: 379 Sheets / 167 PG / 0 dup groups / no orphans introduced.

---

### 2. PG.inventory_items catalog duplicates (87 groups, 108 excess rows) -- TOP INVESTIGATION

**Why top:** this is the one finding the audit could not explain in passing. Two records of the same active catalog item under the same account should not exist. What writer produces these? Module 5 Vendor cutover, INV-3 backfill, intranet-side InventoryManager writes, and cron's catalog-creation path are all candidates.

**Recon needed BEFORE proposing a dedup plan:**
- For 5 sampled dup groups: examine all rows (`created_at`, `created_by`, `vendor_id`, `location_id`, `status`, `linked_to_invoice`, `is_variety_group`). Pattern-match to find the writer source.
- Is there a partial-name-match issue (case / whitespace / unicode) where two genuinely-different items got collapsed by the dedup key (normalized name + account)? If so the dedup key for cleanup needs to be stricter than the discovery key.
- Are some of these legitimate "variety group" parent/child pairs that the dedup key naively collapses?

**Action gate:** investigation only. Plan submitted for approval before any delete.

---

### 3. PG.ai_line_items duplicates (41 groups, 203 excess rows)

**Dedup key for discovery:** `(invoice_uuid, line_num)`.

**Hypothesis (unverified):** these are the cron's re-fires of failed extractions, similar to the review_queue balloon, but for line items rather than queue rows. OR: they are the dup-submission groups (Phase B) producing 2-3 ingestions per shared invoice number.

**Recon needed:**
- Cross-reference with the 25 dup invoice_submissions groups (item #5 below). If the 41 ai_line_items dup groups all belong to invoices in those 25 groups, the root cause is dup submissions, not a separate writer issue.
- Per-group: same `created_at`? same source / `is_historical` flag?

**Action gate:** dedup plan after recon; show-me-before-delete.

---

### 4. PG.price_history duplicates (59 groups, 76 excess rows)

**Dedup key for discovery:** `(item_id, invoice_id)`.

**Hypothesis (unverified):** the cron re-promoting the same (item, invoice) pair to price_history on multiple nights when the invoice ingests multiple times. Linked to either ai_line_items dups (item #3) or invoice_submissions dups (item #5).

**Recon needed:**
- Per-group: do duplicate rows have the same price? If yes, harmless idempotent re-promotion. If different prices, the cron is recording divergent prices for the same physical purchase -- corrupts price-history analysis (price-movers, last-price, averages).
- Cross-reference with items #3 and #5 to confirm shared root cause.

**Action gate:** dedup plan after recon; show-me-before-delete.

---

### 5. PG.invoice_submissions duplicates (25 groups, 30 excess rows)

**Overlap with dup-submission Phase B.** The earlier dup-submission recon (2026-06-09) found 27 groups Sheets-side; PG mirrors 25 (small delta because some Sheets dups are legitimate invoice+credit pairs PG's type-guard distinguishes correctly).

**Sequencing:** this item's resolution IS dup-submission Phase B. The Phase B plan logged at `docs/invoice_extraction_profiles.md` "Logged adjacent items" section already covers the canonicalization mechanic (superseded_by_uuid). Do NOT duplicate the plan here; reference it.

**Action gate:** Phase B ships as its own PR with explicit approval (per the Phase B plan).

---

### 6. NULL-invoice_uuid ai_line_items (260 rows)

**Origin verified:** `scripts/backfill-stl-mo-line-items.mjs` (one-time historical Kuna backfill, 2026-06-01, all rows `is_historical=true`, all `account_key="STL - MO"`, all `vendor_id="KUN-728"`).

**Question for the cleanup pass:** drop these rows, or preserve them as historical-only and explicitly exclude from Module 7's read flips? They cannot be linked to a parent invoice_submissions row; any handler that joins ai_line_items to submissions will skip them anyway.

**Recommendation:** preserve. The rows have `is_historical=true` which the dual-write recon and compliance report already filter on. Module 7's backfill should not re-import them (they are already in PG). Just confirm at Module-7-backfill design time that the load script excludes `is_historical=true` rows when computing what to import.

**Action gate:** decision documented here, no code action needed unless Module 7 design surfaces a conflict.

---

### 7. Sheets ai_line_items orphan invoiceUuids (145 distinct)

**Finding:** 145 distinct `invoiceUuid` values in Sheets `ai_line_items` per-account tabs do NOT appear in Sheets `invoice_submissions_26`. They point to vanished parent submissions.

**Possible origins (unverified):**
- Pre-Module-6-cutover submissions that were deleted from Sheets but whose line items were left
- Historical / backfilled line items from before submissions tracking was canonical
- Soft-deleted submissions where the line items survived

**Recon needed BEFORE deciding action:**
- Per-orphan: when was the line written (col 1 timestamp)? Pattern by account?
- Are these the same uuids as the 260 NULL-uuid PG rows (item #6)? If yes, the same backfill produced both sides.
- Do the orphan uuids appear in PG.invoice_submissions but not Sheets? If yes, the issue is Sheets data loss, not orphan data.

**Action gate:** investigation only; plan after.

---

## Cosmetic (logged, NOT in this cleanup pass)

These are noted for completeness; they do not require pre-Module-7 action.

- **`reconciliation-alarm.js:435` classification note.** "(cron Sheets-only)" comment is slightly stale -- after PR A's review-queue-respect lands in live mode, the cron will also be writing PG via the helper. Cosmetic update; refresh when PR A goes live.
- **invoice_submissions +1 unexplained residue drift.** The known residue rule expects +7 alpha pre-cutover Sheets-only rows; today's count is +8. One row drifted post-rule. Verify which row + decide whether to refresh the residue rule definition.

---

## Tools used by this backlog

| Tool | Repo | Purpose |
|---|---|---|
| `scripts/_probe_pipeline_audit.mjs` | intranet | The audit probe that produced this backlog. Re-run after each cleanup item to verify state. |
| `scripts/_probe_review_queue_cleanup_preview.mjs` | intranet | Read-only preview of the review_queue dedup plan. |
| `scripts/_run_review_queue_cleanup.mjs` | intranet | Execute script for item #1 (default preview, `--execute` flag to delete). |

Per-item tools for items #2-7 will be added as each recon completes.
