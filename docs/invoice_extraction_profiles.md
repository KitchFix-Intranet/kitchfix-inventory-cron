# KitchFix Invoice Extraction - Structure Catalog & Hybrid Profile Spec

**Status:** CENSUS-VALIDATED. Build-ready.
**Purpose:** The build spec for the hybrid extraction layer, and the foundation for the future
invoice-capture promotion. Derived from hand-review of ~25 vendors plus a full-corpus classification
census (736 distinct invoices, the entire deduped corpus).

## Census validation summary

A full-corpus classify run (736 distinct invoices, after removing 74 FIXED_RESUBMITTED re-uploads
and 711 RAW/processed pair-duplicates) confirmed and refined this catalog:

- **0 UNKNOWNs across all 736 invoices.** The 6-family catalog covers the ENTIRE corpus. No 7th
  structure exists. The catalog is complete, not just "complete as far as we looked."
- **Vendor-keying is sufficient** - vendors do NOT split across structural families by region (the
  earlier Sysco/Shamrock "multi-layout" suspicion was a 20-sample artifact; at scale they are 100%
  single-family + their credit memos). Profiles key on vendor, not (vendor, region).
- **Catch-weight is the dominant cross-cutting failure** (see "Build strategy" below) - confirmed by
  reading the per-invoice rationales, not just fail-rates.

### Family breakdown (n=736)

| Family | n | % | What |
|--------|-----|-------|------|
| F1 | 325 | 44.2% | Clean printed |
| F5 | 189 | 25.7% | Rotated / dense grid |
| SKIP-A | 53 | 7.2% | Credit memos |
| SKIP-B | 53 | 7.2% | Non-food vendors |
| F3 | 50 | 6.8% | Printed cases + catch-weight (BEK, Gordon) |
| F4 | 36 | 4.9% | Handwritten cases (Cheney) |
| F2 | 17 | 2.3% | Weight-as-quantity (seafood) |
| F6 | 13 | 1.8% | Beverage distributors |

Food-family invoices: 630 (85.5%). Correctly-skipped: 106 (14.4%).

---

## Build strategy - catch-weight capability first (the key reframe)

The census reframed the build from "build the F1 profile first (biggest family)" to **"build the
shared catch-weight extractor first,"** because:

**Catch-weight is what's failing, across multiple families - and it's the SAME structural shape.**
Reading the failing-invoice rationales confirmed:
- **What Chefs Want** (your biggest food vendor, 119 inv): ~19 of 22 failures are catch-weight, via
  a "Case weights: X.XX, TOTAL: X.XX" sub-line. Spans proteins, cheese, weight-sold produce, truffle.
- **Gordon Food Service**: failures are IDENTICAL in shape to WCW - F1 main row + catch-weight
  sub-line - just different markers ("TOTAL WEIGHT: ##.###", "CASE: <id> WEIGHT: ##.###"). The
  foots-OK Gordon invoices have no catch-weight lines at all.
- **Ben E Keith** (F3, 38% fail): catch-weight via "Total Weight ##.##" sub-line (already specced).
- **Fresh Point** (24% fail): catch-weight is PART of its failures (proteins).
- **Cheney (F4), Sysco/Kuna (F5)**: catch-weight lines via their own markers.

So one capability - **detect a catch-weight sub-line structurally, derive qty = TOTAL weight ×
unitPrice** - addresses the largest single bucket of failure, concentrated in the biggest vendor
(WCW). It applies across F3, the catch-weight lines within F1 (WCW/Gordon/Fresh Point proteins), and
F4/F5 weight lines. This is higher-leverage than any single vendor profile and is ONE well-defined
capability rather than N profiles.

**The shared catch-weight extractor must read all observed sub-line markers:**
- `Case weights: X.XX, TOTAL: X.XX` (What Chefs Want)
- `TOTAL WEIGHT: ##.###` (Gordon, Ben E Keith)
- `CASE: <id> WEIGHT: ##.###` (Gordon per-case format)
- `T/WT= ##.###` (Sysco)
- `Weights: TOTAL= ##.## ==>>>>` (Kuna)
- printed WEIGHT column where weight × unitPrice ≈ amount (Cheney catch-weight lines)

### Marker proof status (updated as we validate)

The prompt asks Claude to capture all markers above, but they have different
levels of empirical validation. PR 1's held-out probe validated extraction +
derivation + gate-pass on a subset; the rest are expected to work by symmetry
and get verified at scale by the shadow run (PR 3) or by future targeted
probes. Honest about what's proven; honest about what's not.

**PROVEN (validated in PR 1's held-out probe against real invoices):**
- `Total Weight ##.##` / `Weight: ##.##` sub-line (Ben E Keith) - verified on BEK Beef Chuck (`weightLineValue=103`), plus bonus Pork Belly (28.95#), Beef Flank Steak (83.10#), Beef Ribeye (44.85#), Beef Tenderloin (14.75#), Beef Tri-Tip (16.17#), Beef Flat Iron (22.60#), Chicken Thigh (20.88#). Every catch-weight line on BEK F3 invoices recovers via `catch_weight_subline` derivation. Legacy claude-qty gate FAILed every one; derived gate PASSes every one.
- `TOTAL WEIGHT: ##.###` and per-case `CASE: WEIGHT: ##.###` (Gordon Food Service) - verified on Beef Flank (`weightLineValue=35.500`, 35.5 × 9.55 = 339.03 ✓) and Beef Grnd 80/10 (`weightLineValue=76.900`, 76.9 × 6.53 = 502.16 ✓).
- Weight-in-SHIPPED-column form (What Chefs Want, on lines that do NOT have a "Case weights" sub-line) - verified on WCW Grouper (`shippedCount=14.6`, `unit=lb`, 14.6 × 30.24 = 441.50 ✓). Goes through `shipped_passthrough`, not `catch_weight_subline`, but produces the correct LB result. NEW FINDING: WCW has BOTH catch-weight presentations - some lines use the sub-line, some put the weight directly in the SHIPPED column. The derivation handles both.
- `T/WT= ##.###` sub-line (Sysco) - validated by the F5 recon on Sysco #519239063: BEEF FLANK 193 captured `weightLineValue=157.90` (157.90 × $11.39 = $1798.48 ✓), BEEF STRIP LOIN 0X1 1/4 USA captured `weightLineValue=50.10` (50.10 × $9.27 = $464.43 ✓). Both lines: legacy claude-qty gate FAIL -> derived gate PASS. The shared catch-weight extractor handles Sysco T/WT= without any new logic.
- `Case weights: X.XX, ..., TOTAL: Y.YY` sub-line form (What Chefs Want) - validated on WCW #12480028: BEEF OXTAIL SLICED E/E captured `weightLineValue=13.85` from the `"Case weights: 13.85, TOTAL: 13.85"` sub-line (13.85 × $15.15 = $209.83 ✓). Note: the model populated BOTH shippedCount=13.85 AND weightLineValue=13.85 on the catch-weight line (per the prompt's instruction to populate both); derivation correctly chose weightLineValue via `catch_weight_subline`. WCW now PROVEN across BOTH catch-weight presentations: this Case-weights-TOTAL sub-line form AND the weight-in-shipped-column form (Grouper #12723357 earlier).
- Printed WEIGHT column on Cheney F4 catch-weight lines - validated on Cheney #06-910725356: BEEF FLANK STEAK captured `weightLineValue=10.71` (10.71 × $96.20 = $1030.30 ✓), BEEF GROUND PATTY captured `weightLineValue=36.00`, HAM SLICED COOKED captured `weightLineValue=12.00` (12 × $6.82 = $81.84 ✓), TURKEY SLICED ROAST captured `weightLineValue=12.00` (12 × $7.72 = $92.64 ✓). All four lines: legacy claude-qty gate FAIL -> derived gate PASS via `catch_weight_subline`. **NEW FINDING - per-invoice variable Cheney behavior:** PR 1's probe on Cheney #20-910762161 found the model put the printed weight in shippedCount (e.g. Pork Tenderloin shippedCount=35.28, weightLineValue=null, shipped_passthrough path produced the correct LB result). This probe on Cheney #06-910725356 found the model puts it in weightLineValue (catch_weight_subline path). The model's per-line column-assignment choice on F4 invoices varies; BOTH paths produce correct inventory output via the appropriate derivation reason. The spec's prompt instruction does not need tightening for Cheney - whichever field the model populates, derivation routes correctly.

**PARTIALLY PROVEN (marker captures into weightLineValue, but other line fields are unreliable on the same line so derivation extracts the right weight while the line may still gate-fail):**
- `Weights: TOTAL= ##.##` sub-line (Kuna) - validated by the F5 recon on Kuna #217995-00: BEEF BRISKET CO FLKT 185 captured `weightLineValue=15.04`. The marker WORKS - the prompt correctly extracts the total weight from the Weights:TOTAL= sub-line. BUT Kuna's scan-quality residue often misreads `unitPrice` or `amount` on the same line (15.04 × $4.02 = $60.46 but amount = $57.11, ~6% off due to a unitPrice misread). Expected behavior in shadow: Kuna catch-weight recovers PARTIALLY - some lines appear in would-recover; others appear in residual due to the scan-quality limit, not due to a derivation bug. The residual is the correct review-queue floor for blurry Kuna scans, not an alarm.

**UNPROVEN: NONE.**
All catch-weight sub-line markers in the prompt are now validated against real invoices. The full marker set is PROVEN (Sysco T/WT=, Gordon TOTAL WEIGHT + CASE: WEIGHT, BEK Total Weight, WCW weight-in-shipped-column, WCW Case weights TOTAL, Cheney printed WEIGHT column) plus one PARTIALLY PROVEN (Kuna Weights: TOTAL=, marker captures but scan-quality limits the line). The catch-weight extractor capability is closed - shadow validates at scale; no further marker probes required.

**Honest-null principle - PROVEN as a universal load-bearing assertion:**
PR 1's probe ran the honest-null principle check on every line of every test
invoice (50+ lines across BEK, WCW, Gordon, Cheney, Kuna, Peddler's, Fortune
Fish). 20/20 honest-null candidates correctly returned `derivedQty=null` and
gate=HELD - none were back-computed, none silently passed. This is the
load-bearing assertion that distinguishes "honest null routed to review" from
"failed the gate" and is what protects against the Stage A circular-gate
bug class. The principle is universal across families and verified at scale.

### F5 cluster recon findings (Sysco / Shamrock / Kuna)

A targeted F5 recon (read-only, ~$0.30 in API costs) validated the markers
above on real invoices and surfaced two additional findings that close the
F5 work without any new code. See above for the Sysco PROVEN + Kuna
PARTIALLY PROVEN status updates produced by this recon.

**Shamrock density-misread (NEW failure mode, NOT catch-weight):**

The Shamrock F5 invoices in the census show a distinct failure pattern that
is separate from catch-weight: the model loses column alignment in
Shamrock's dense "compartment totals" layout (DRY / FROZEN / REFRIG
sections) and reads the SAME value into both the qty cell and the amount
cell. Examples from the census rationales:
- `HP BUTTERMILK 1% LF`: `qty=7 unit=$22.09 amount=$22.09` (math foots only if qty=1; the actual qty was 1, the model read 7 from an adjacent cell)
- `HALF & HALF, QT REFRIGER`: `qty=14 unit=$22.21 amount=$22.21` (same pattern, actual qty was 1)
- `JUICE, APPLE 100% FRT`: `qty=3 unit=$35.98 amount=$35.98` (same pattern)

This affects ~14 of the 25 Shamrock failures in the census (the other 11
are catch-weight or scan-quality). The arithmetic gate CORRECTLY catches
these: the line fails, routes to `review_queue` with reason="arithmetic_fail",
and a human resolves it. NO vendor-specific extraction code is added.
Adding a Shamrock-specific prompt hint to fix column alignment would violate
the spec's "detect by STRUCTURE" principle for a low-volume failure mode
(~2% of corpus) that the gate already handles safely. Documented as a
known review-queue resident.

**Rasterization is a dead end for blurry scans:**

The recon tested whether higher-DPI rendering of bad Kuna scans (via
qlmanage at -s 2500, approximately 225 DPI) would recover readable numbers
vs sending the natively-embedded JPEG. It does NOT, and on the 2 tested
invoices (#22416-00, #215530-00) the rasterized variant produced WORSE
results: more null unitPrice/amount cells (5/8 and 3/7 null) than the
native variant (0/4 and 0/7 null), plus hallucinated descriptions like
`"CRIS:BULK PREPACKAGED S:OZ ORDER:ID UNIT"` and
`"TELL AVOCADO SET 1 GAL 4/1 ABIEO"`.

Why: the embedded JPEG in those PDFs is already approximately 135 DPI on
US-letter (1200x1600 pixels in a 385 KB JPEG), which encodes the original
scan quality. The blur is in the SOURCE scan (someone photographed or
scanned the invoice at low quality), not in the encoding. Re-rendering
from that source at higher pixel count can't add information that is not
there; it just produces PNG re-encoding artifacts and gives Claude more
pixels to hallucinate descriptions from.

The approximately 10-11 blurry Kuna and Shamrock invoices (approximately
1.4% of corpus) are an honest review-queue floor. This is an upload-quality
problem, not a pipeline problem to engineer around. (See "Logged adjacent
items" - the upload-compliance report we are about to spec will surface
the same invoices from the upload-discipline angle.)

**F5 closure:**

No code PR is needed for F5. The PR 3 shadow window will validate at scale:
expect Sysco/Kuna catch-weight lines to appear in `would-recover` as fresh
F5 invoices flow through, with the residual concentrated in the
scan-quality floor + Shamrock column-misreads. Both of those residual
buckets are correct behavior, not bugs.

### Refined build order (by volume × failure, with the catch-weight reframe)

1. **Shared catch-weight sub-line extractor** - FIRST. Fixes WCW (22, biggest vendor), Gordon (5),
   BEK (F3), and the protein lines in Fresh Point. ~30-40+ recoverable invoices, one capability.
   Also stands up the hybrid skeleton (detector + profile selection + shadow mode) on a well-defined
   target.
2. **F5 density/quality handling** - Sysco (75, 21%) + Shamrock (77, ~28%) + Kuna (37, 19%). A
   quarter of the corpus. Mostly workable natively; Kuna's bad scans are an image-quality floor (see
   F5 notes). Catch-weight lines here reuse the shared extractor.
3. **Fresh Point column-disambiguation** - list-price vs. net-price columns (see F1 notes). Separate
   from catch-weight; explains ~2/3 of Fresh Point's failures. Smaller, additive.
4. **F4 Cheney handwritten** - catch-weight lines fixed by the shared extractor; handwritten case
   counts -> review-queue floor.
5. **Generic prompt** is sufficient for the clean tail (no profile needed): Fortune Fish (0% fail),
   Sunfresh (0%), City Seafood (F2, 0%), Rolling Lawns (0%), Vio (0%), Truly Good Foods (0%),
   Peddler's (5%), and the long tail of single-invoice vendors.
6. **Prompt fixes** - tighten F6 vs SKIP-B (the Vio leak, below).
7. **Review dashboard** - the human-resolution floor for F4 handwritten + F5 bad-scan residue.

Build discipline (unchanged): each profile/capability is built, run in SHADOW mode against real
invoices (would-recover / would-regress per vendor), confirmed regress≈0, THEN cut live. The
held-out-test + shadow gates are what caught the circular-gate bug in Stage A; they protect every
cutover.

---

## Core principles (apply to every family)

1. **Detect by STRUCTURE, validate by ARITHMETIC - never by magnitude or position.** Recurring
   failure mode: a wrong number that's *plausible*. Examples: Gordon Pack Size "16x3.25" = 52.0
   vs. actual weight 51.520 (nearly foots); Lohr qty column renders one row offset from its total.
   The `qty × price ≈ amount` checksum catches these. Don't key on "small price = catch-weight" or
   "row N = line N."

2. **Separate EXTRACTION from INTERPRETATION.** Claude reads raw labeled fields faithfully; CODE
   derives quantity-for-pricing. Code is testable, deterministic, versionable.

3. **A null is honest; a back-computed value is a lie.** When a required field can't be read, return
   null and route to review. NEVER back-compute (e.g. `quantity = amount ÷ unitPrice`) - it makes
   the gate pass by construction (the circular-gate bug that failed Stage A).

4. **The arithmetic gate stays.** `|derived_qty × unit_price - extended| ≤ 2% × |extended| + 0.01`.
   It correctly catches upstream extraction errors. It must be able to FAIL.

5. **The review queue is the floor, and that's correct.** Genuinely-unreadable lines (handwritten
   case counts, blurry rotated scans) are honestly held for human resolution, not forced into fake
   capture. Holding 20% honestly beats capturing 100% with wrong numbers.

---

## Skip mechanisms

### SKIP-A - Credit memos
- **Signal:** `type = 'credit'` on `invoice_submissions` (col P, operator-selected), OR negative
  total, OR "CREDIT" watermark / "Credit #" header.
- **Action:** Excluded from inventory ingestion; still extracted + stored in `ai_line_items` for
  finance/bill.com.
- **Status:** SHIPPED (Stage 0, cron PR #8, live). Census: 53 invoices (7.2%).
- **Note:** "Shamrock Foods Company" (vs. "Shamrock Foods Company PHX") is a credit-memo-only header
  variant - a useful quick heuristic, but the `type` field is the authority.

### SKIP-B - Non-food vendors (CONFIRMED LIST)
- **Signal:** Vendor is a service/supplier that doesn't stock kitchen inventory.
- **Confirmed members:** Alsco (uniforms, 21), Cozzini (knife sharpening, 17+1 label variant),
  Cintas (uniforms, 6), Vestis (linen, 2), Sodexo Operations/InReach (service, 2), Ferrell Gas
  (propane, 1). All confirmed non-food by Kevin.
- **Action:** Skip line-item extraction entirely; route to bill.com only. Vendor-level skip
  (allowlist/denylist keyed on vendor).
- **Census edge cases (resolved):**
  - **Vio Brands** -> NOT SKIP-B. It's food (Chobani Yogurt, foots OK). The lone SKIP-B read was a
    misclassification (model conflated "not F6" with "skip"). Vio = F1.
  - **St. Armands Baking** -> food vendor (F1). One of its invoices is a zero-qty route-summary/
    standing-order doc (non-inventory) that was reasonably skipped; its normal deliveries are F1.
  - **Sysco "GL coding summary"** -> not a vendor issue; a stray non-invoice accounting doc in the
    folder. Corpus contains a few such non-invoice files.
- **Curation note:** Kevin is the authority on this list, not the classifier. Model SKIP-B error
  rate ~1.9% (1 in 53). Confirm any future additions against actual vendor knowledge.
- **Status:** NOT YET BUILT.

---

## The 6 structural families

### F1 - Clean Printed (325 inv, 44.2%)
*The largest family - and mostly clean. The work is the catch-weight lines within it.*

- **Detection:** Printed quantity column(s) - single qty or ordered+shipped pair; per-unit price;
  printed amount. No rotation, no handwriting.
- **Derivation:** `quantity = shipped` (or single qty column). Standard per-unit pricing.
- **Foot-rates (census):** Most of F1 already foots clean - Fortune Fish 0%, Sunfresh 0%, Rolling
  Lawns 0%, Vio 0%, Truly Good Foods 0%, Peddler's 5%. **These need no profile - generic prompt is
  fine.**
- **The F1 vendors that FAIL, and why (census rationales):**
  - **What Chefs Want (18% fail):** catch-weight lines ("Case weights: X.XX, TOTAL: X.XX" sub-line)
    on proteins, cheese, weight-sold produce, truffle. -> handled by the shared catch-weight extractor.
  - **Fresh Point (24% fail): THREE failure modes -**
    1. Catch-weight on proteins -> shared catch-weight extractor.
    2. **List-price vs. net-price column confusion** - Fresh Point invoices have BOTH a list price
       column AND a billed/net price column; the model grabs list when it should grab net. -> needs an
       explicit column-disambiguation step (which column is "billed unit price"). ~3 of 9 failures.
    3. Bogus unit reads - a UPC/pack-size cell read as the unit price (e.g. unit=$112). -> cell-
       identification guard.
- **Catch-weight within F1:** handled by the shared catch-weight extractor (NOT a separate F1 rule).
  The sub-line markers vary; the extractor reads all of them.
- **Traps:** Zero-ship lines (shipped=0 -> blank extended) are correct. Mixed units (BOX/CASE/EACH) -
  read uomRaw per line. Item codes sometimes inside the description (Vio). List/net column confusion
  (Fresh Point). UPC/pack cells misread as price (Fresh Point).
- **Members:** Peddler's Son, Fresh Point, Sunfresh Produce, What Chefs Want (non-credit), Fortune
  Fish Gourmet, Rolling Lawns Farm, Katz Coffee, Truly Good Foods, Vio Brands, + clean tail.

### F2 - Weight-as-Quantity (17 inv, 2.3%)
*Simple seafood. Census foot-rate: 0% fail (City Seafood) - clean.*

- **Detection:** Qty column literally holds the weight ("10.60 pounds", "38.60"); per-pound pricing;
  minimal layout.
- **Derivation:** `quantity = weight in qty column`; `unit = lb`; `weight × unitPrice = amount`.
- **Traps:** A "delivery charge" line (category "other"). Don't confuse invoice-level "Total Weight"
  footer with a per-line value.
- **Members:** City Seafood, Samuels Seafood.
- **Notes:** Generic/simple handling is fine - this family foots clean.

### F3 - Printed Cases + Catch-Weight Sub-line (50 inv, 6.8%)
*BEK + Gordon. 38% fail (BEK). Catch-weight via sub-line - folds into the shared extractor.*

- **Detection:** Printed Cases column; catch-weight items add a "TOTAL WEIGHT: ##.###" sub-line;
  pack-size is a SEPARATE descriptor column.
- **Derivation (confirmed by checksum):**
  - Standard line: `quantity = Qty Ship`; `extended = Qty Ship × unitPrice`.
  - Catch-weight line: `quantity = TOTAL WEIGHT sub-line`; `unit = lb`; `extended = TOTAL WEIGHT ×
    unitPrice`. (BEEF FLANK: 35.500 × 9.55 = 339.03 ✓; BEEF GRND: 76.900 × 6.53 = 502.16 ✓)
  - **Discriminator: presence of the sub-line.** NOT Cat code, NOT Qty value, NOT price magnitude.
- **THE PACK SIZE TRAP:** Pack Size numerically approximates the billed weight on catch-weight lines
  ("16x3.25" -> 52.0 vs. actual 51.520). **Pack Size is opaque text - no numeric extractor touches it
  for qty/weight.** Qty from Qty Ship; weight from the TOTAL WEIGHT sub-line.
- **Other line types:** Fuel Charge/freight (category "other"), tax on some lines, TempOut/no-ship
  lines, Group Summary rollups (skip).
- **Members:** Ben E Keith (pure F3), Gordon Food Service (F1-clean + catch-weight sub-lines).
- **Notes:** Gordon is NOT its own profile - its catch-weight folds into the shared extractor; its
  clean lines are F1. The foots-OK Gordon invoices have no catch-weight at all.

### F4 - Handwritten Cases (36 inv, 4.9%)
*Cheney. 42% fail. The hard one - partial review-queue floor.*

- **Detection:** Printed Weight/UnitPrice/Amount columns, but the Cases/quantity column is
  HANDWRITTEN/circled in pen - faint, leftmost data column.
- **Column order:** LINE | LOCATION | CASES(handwritten) | PKGS | ITEM NO | BRAND | PACK/SIZE |
  DESCRIPTION | WEIGHT | UNIT PRICE | UOM | AMOUNT.
- **Derivation:**
  - Standard line: `quantity = handwritten CASES`. Read when legible; else `shippedCount = null` ->
    review. NEVER back-compute. (Yogurt Greek Plain: CASES=3 handwritten, 3 × 41.45 = 124.35 ✓)
  - Catch-weight line: detected structurally (printed WEIGHT column + weight×unitPrice≈amount);
    `quantity = WEIGHT column`; `unit = lb`. (Pork Loin: 82.30 × 8.01 = 659.22 ✓) -> shared extractor.
- **Traps:** Handwritten CASES is the core difficulty - no model reliably reads pen scribbles.
  Catch-weight lines (printed weight) extract fine via the shared extractor; standard lines
  (handwritten cases) are the review residue.
- **Members:** Cheney Brothers.
- **Notes:** Realistic target - catch-weight lines extract reliably; handwritten-cases standard lines
  extract when legible, ELSE honest null -> review. Permanent review-queue residents are correct here.

### F5 - Rotated / Dense Grid (189 inv, 25.7%)
*A quarter of the corpus. 19-28% fail. Two distinct problems: density (logic) and scan-quality
(pixels).*

- **Detection:** Page sideways; dense boxed/cramped cells; ordered/shipped present but cramped;
  catch-weight via "T/WT=" (Sysco) or "Weights: TOTAL=" (Kuna) sub-lines.
- **Derivation:** standard `quantity = shipped`; catch-weight `quantity = T/WT=` or `Weights:TOTAL=`
  sub-line -> shared catch-weight extractor. The layout density is the challenge, not the logic.
- **Rotation: handled natively** - native PDF sending classifies all F5 correctly (verified). The
  rotation-metadata path works for STRUCTURE.
- **BUT - scan-quality is a separate problem (census finding on Kuna):** Kuna's 7 N/A failures are
  image-quality, NOT structure - "rotated, text too blurry/faint to reliably extract." The model
  recognizes the lines exist but can't read the numbers (qty=1, unit=null, amount=null). Native
  sending doesn't help blurry pixels.
  - **Mitigations (in order of preference):** (a) accept review-queue floor for the worst scans
    (~5-15% of Kuna) - a human reading a blurry invoice is the right workflow; (b) test higher-DPI
    rasterization (300 DPI) on the 7 N/A samples before committing it as a pipeline step; (c)
    deskew/contrast preprocessing; (d) multi-pass re-prompt on null values.
  - The 30 Kuna invoices that foots-OK had workable rotation/density - the N/A subset is the
    bad-scan tail, not a structural failure.
- **Traps:** Density/cramped cells cause misreads. Summary rows ("GRAND TOTAL", "SPLITS") must be
  skipped (Kuna returned "GRAND TOTAL" as a line item in an early test). Blurry scans -> review floor.
- **Members:** Sysco (pure F5 at scale), Shamrock Foods (pure F5; "PHX" is a regional header variant,
  same structure), Kuna Foodservice (pure F5).
- **Notes:** Hardest family, biggest review floor. NOT multi-layout (the F5/F1 split was a sampling
  artifact). Build after the shared catch-weight extractor; catch-weight lines here reuse it.

### F6 - Beverage Distributor (13 inv, 1.8%)
*Multi-section with deposits/returns. Field-level ground truth confirmed on Lohr.*

- **Detection:** Multi-section (SALES + DEPOSITS/RETURNS + RECAP); qty printed in dense line format;
  UPC/material codes; deposit/return lines that can be negative.
- **Derivation:** `quantity = qty/cases column`; standard per-unit pricing. Core work = identifying
  product rows vs. non-product line types, keeping only products.
- **Non-product line types to FILTER (confirmed on Lohr):** Deposit Refund lines (often a printed
  RATE SCHEDULE, not credits applied - drop), carried-balance rows (key off "Cur Bal / prior-invoice"
  pattern, not position), footer count/tally rows, admin rows.
- **RECONCILIATION TRIP-WIRE:** Product TOTALs alone sum exactly to invoice total -> deposits never
  enter the math, drop them. If total does NOT reconcile from product TOTALs alone -> a deposit/credit
  was actually applied, needs handling. Self-validating.
- **COLUMN-OFFSET TRAP (Lohr):** Qty column can render one row offset from its price/total (fixed -1
  shift, consistent). **Pair by `qty × net = total` checksum, not row geometry.** Footer counts =
  second cross-check.
- **DEP column:** per-line structurally but often a zero column-total. Read per-line, expect zero,
  don't hard-code "always blank."
- **Members:** Swire Coca-Cola, Grey Eagle, Pepsi (PepsiCo Beverages), Lohr Distributing.
- **Prompt fix:** Tighten F6's definition to require a "deposits/returns sub-section," NOT just
  "beverage vendor" - this stops "not-a-beverage-distributor" from sliding into SKIP-B (the Vio leak).
- **Notes:** Small family (1.8%) but real. More logic than F1 - line-type filtering + reconciliation
  + checksum-pairing. Low volume -> lower build priority.

---

## Profile-priority summary (volume × failure)

**Build (high volume × high fail):**
1. Shared catch-weight extractor - fixes WCW (119 inv/18%), Gordon, BEK (50/38%), Fresh Point
   proteins. Highest leverage.
2. F5 cluster - Sysco (75/21%), Shamrock (77/28%), Kuna (37/19%). A quarter of corpus.
3. Fresh Point column-disambiguation (33/24%) - list/net + bad-cell, additive to catch-weight.
4. F4 Cheney (36/42%) - catch-weight via shared extractor; handwritten -> review floor.

**Generic prompt sufficient (clean):** Fortune Fish (0%), Sunfresh (0%), City Seafood (0%), Rolling
Lawns (0%), Vio (0%), Truly Good Foods (0%), Peddler's (5%), long tail.

**Review-queue floor:** Cheney handwritten cases, Kuna bad scans, any foots=FAIL where extraction
genuinely can't recover.

---

## Logged adjacent items (not extraction logic)

- Duplicate `ai_line_items` rows from FIXED_RESUBMITTED re-uploads AND RAW/processed pairs - confirm
  extraction ingests only the submitted version; dedup existing dupes. (Data cleanup.)
- Filename invoice-number vs. printed invoice-number mismatches (TGF, Vio). (Minor data hygiene.)
- Non-invoice files in the corpus folder (Sysco GL-coding doc, St. Armands route-summary) - capture
  could detect/route these.
- 1 errored Kuna invoice in the census (predates the JSON-salvage fix) - re-run with --force to
  validate the salvage code if desired.
- Successor project: promote this family-aware extraction intelligence UPSTREAM into invoice capture
  (the cron hybrid is the prototype; promote once proven). This census IS the requirements doc and
  the baseline to measure the rebuild against.
- Shamrock density-misread is a candidate for the eventual review-dashboard's "common patterns"
  panel. When the dashboard is built, Shamrock column-alignment fails will be a recurring resident
  worth surfacing as a GROUP (one-click bulk-resolve workflow on the same failure shape) rather
  than as individual one-off review items. Volume approximately 14 invoices in census.
- Blurry-scan floor (the Kuna + Shamrock N/A invoices, approximately 1.4% of corpus per the F5
  recon) directly feeds the planned upload-compliance report. The same invoices that are unreadable
  by extraction are unreadable because they were UPLOADED badly (low-res photo, crumpled, poor
  lighting). The compliance report and the F5 scan-quality floor look at the same invoices from
  two angles: extraction sees them as "unrecoverable lines"; compliance sees them as "operator
  uploaded a bad scan." Both pipelines should surface the same uuids so the operator gets a
  single coherent signal, not two contradictory ones.
- Duplicate `invoice_submissions` dedup plan (APPROVED IN PRINCIPLE, NOT YET BUILT). Recon found
  27 duplicate groups across 800 submissions (3.5%): operators submit the same invoice multiple
  times, creating multiple invoiceUuids each with their own ai_line_items rows. Sampled 4 accounts
  showed ~11 groups with TRUE duplicate ingestion (all uuids present in ai_line_items); worst case
  was Sysco #103349834 with 3 submissions x 43 lines = 129 line items for one invoice. The RAW +
  processed Drive folder pair (711 paired files from the corpus census) is a DRIVE-side storage
  artifact, NOT a duplicate ingestion - each submission stores both copies but is still one
  ingestion. The duplicate-ingestion issue is at the submission-pipeline level.
  CRITICAL grouping detail: must group on `(account_key, vendor_id, invoice_number, type)` NOT
  just `(account, vendor, invoice_number)`. The invoice + credit memo pair often share the same
  invoice number (legitimately - the credit references the invoice it credits). Caught in recon
  via Shamrock #36598788 (CIN-AZ) where an invoice + credit pair had matching numbers; grouping
  without the type guard would have corrupted both records on dedup.
  Phased plan (sequenced AFTER the upload-compliance report; joint-design candidate):
    Phase A: forward-fix at submission time. Check `invoice_submissions` for an existing row
      matching (account_key, vendor_id, invoice_number, type) within the last 30 days where
      status is not in ('corrected','returned','deleted'); if found, prompt the operator
      ("Looks like you already submitted this on {date}. Continue anyway?"). This is
      COMPLIANCE-ADJACENT (catches bad operator upload behavior at submission time), same
      domain as the upload-compliance report. The two should share design where possible so
      we don't build one in ignorance of the other.
    Phase B: canonicalize existing duplicates via a `superseded_by_uuid` column (or status
      value like 'superseded-by-{uuid}'). Pick canonical by status='sent' > 'photo-only' >
      most-recent-submittedAt. Flag the non-canonical ai_line_items rows with a `superseded`
      flag (new column, additive migration). The cron's processedInvoices dedup gets a small
      change: also skip superseded=true rows.
    Phase C: decide deletion vs retention later, after Phase B has stabilized for 1-2 weeks.
      Default recommendation: retain flagged for audit, do not delete.
  Not a fire: ~50-200 duplicate rows org-wide, EXTRA rows not MISSING data. Catalog accuracy
  impact is real but bounded. Recon probe is at `scripts/_probe_duplicate_invoices.mjs` in the
  intranet repo (untracked).
