<!-- Moved out of CLAUDE.md on 2026-11-27 to keep session start small. Read when a task touches this area; keep it up to date. -->
# Scheduled jobs (pg_cron → Edge Functions, times in UTC)
| Job | Schedule | Function | What it does |
|---|---|---|---|
| sheet-sync | every minute | `sheet-sync` | Pushes queued campaign changes (`campaign_sheet_sync`) to the Campaign Overview sheet via the Apps Script web app. |
| overview-pull | every 5 min | `sheet-sync` `{action:pull_overview}` | Reads the whole sheet tab into `overview_snapshot`, then `pullEdits` copies sheet edits into linked campaigns. |
| daily-stats-refresh | */5, 02:00–04:55 | `refresh-stats` | ScrapeCreators (TikTok) and the YouTube API, in batches. One fetch per video per day; skips campaigns ended more than 30 days ago. |
| roster-refresh | */10, 01:00–03:50 | `roster` | Refreshes roster creators' stats (25 due creators per run, so CSV imports fill in within a night or two). |
| trending-charts | */5, 04:00–05:55 | `chartmetric-sync` | Spotify Top 200 and Shazam per `trend_countries` row → `trend_chart_rows` → `trend_scores`, momentum and signals. |
| deck-notify | every 2 min | `deck-notify` | Slack summary for each finished deck view. |
| fx-rates | 05:20 | `fx-rates` | ECB rates → `fx_rates`. All totals are converted to USD. |
| invoice-plan | 06:15 daily | SQL `private.run_invoice_plan()` (no HTTP) | Invoice plan parts of active campaigns due today (or up to 3 days late) with no request: `auto_request` → makes the invoice request itself (`requested_by` 'Stellar OS (plan)', notes 'Invoice plan · <label>'; not if it would take requests over the budget), otherwise one `invoice_plan_due` alert to the campaign people. |
| retainer-requests | 06:15 daily | SQL `private.create_retainer_requests()` | Old monthly retainer job, replaced by the invoice plan; does nothing (no campaign has a retainer). Unschedule with Sam's OK. |
| paypal-sync | every 5 min, only while a payment is on its way | `paypal-payouts` (x-deck-secret) | Reads PayPal's status for open payments; marks rows Paid on success. |
