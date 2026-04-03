# KitchFix Inventory Cron

Nightly AI-powered catalog matching for the KitchFix Inventory Manager.

## What It Does

1. Reads new invoice line items from `AI_LINE_ITEMS` (per-account tabs)
2. Sends ONE Claude API call per account with new items + existing catalog
3. Claude handles all data quality in a single pass: noise filtering, unit normalization, category mapping, snack detection, variety grouping, catalog matching
4. Auto-approves high-confidence matches (≥90%) → writes to `item_catalog`, `item_aliases`, `price_history`
5. Queues low-confidence matches → writes to `review_queue`
6. Posts Slack digest (nightly summary + Monday catalog health)

## Railway Setup

1. Create a new project on [railway.app](https://railway.app)
2. Deploy from the `kitchfix-inventory-cron` GitHub repo
3. Set the cron schedule: `0 6 * * *` (midnight CT = 6am UTC)
4. Add environment variables (see below)

## Environment Variables

```
GOOGLE_SERVICE_ACCOUNT_EMAIL=kitchfix-sheets@speedy-actor-487922-p4.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
ANTHROPIC_API_KEY=sk-ant-...
INVENTORY_SHEET_ID=14oR0cj9hyQJfK0m-ZXUDn6qvOviZYX1aLMs27V8zZnk
GOOGLE_AI_LINEITEMS_SHEET_ID=18mTWaeodOpFVmDSNRkGpNZvCrNWqHxVv3qN8r1b2REo
MASTER_HUB_SHEET_ID=1rvIg9trPCxiEWvzrYbtp1j7V_sbtQnKaysv5BOwA90E
MATCH_CONFIDENCE_THRESHOLD=90
SLACK_RECAP_WEBHOOK=https://hooks.slack.com/services/...
```

## Testing Locally

```bash
npm install
# Set env vars in .env or export them
node index.js
```

## First Run

On first run, the cron processes ALL historical line items since there's no prior price_history. This is the backfill. Subsequent runs only process invoice UUIDs not yet seen in price_history.

