# Stellar OS: quick map for Claude

Read this first. README.md has the long, human version. This file is the short version, so it never holds secrets: the repo is public.

## Ground rules (from Sam)
- Clients never see budgets, spend, margins, payouts or creator costs. The `share` function is the only thing clients reach, and it must never read those tables.
- Secrets live in Supabase secrets or `private.settings`. They never go in the repo or in chat. Don't commit the sheet secret.
- Database changes are additive only: no column or table drops. New tables get RLS (`private.is_team_member()`) and explicit grants to `authenticated`.
- No destructive actions, purchases, account creation or password entry without Sam's explicit OK.
- Regions are named **West** (Americas), **Central** (Europe, Africa, Middle East up to Russia) and **East** (Asia incl. Japan and Australia). Keep those names.
- Copy style: plain words, no jargon, in-app dialogs (`dialog.js` `confirmDialog`). Never use `confirm()` or `prompt()`.

## Pending fixes (Sam's to-do list)
Sam asked: keep these until he asks to solve them, and **list them every time he asks to build or fix something else**. Remove an item only once it's done.
1. **Spot new posts cheaply:** once a day, check the newest videos of the creators on each active campaign's payout sheet through ScrapeCreators (about 1 credit per creator) and add any video that uses the campaign's sound to the right folder. Replaces paying Influencers.club monitoring (0.3 credits per creator per day).
2. **Cheaper audience lookup:** `creator-insights` buys Influencers.club "Full" (1 credit). Split it: "Analytics" (0.8) when only the audience is needed, "Profile" (0.2) when only the email is needed.
3. **Influencers.club top-up only when needed:** for vetting on the payout sheet (audience location vs the client's market, audience credibility score) and lookalike shortlists seeded from the campaign's best-performing creators. Their account currently has no credits.

## Stack
- Front end: static ES modules on GitHub Pages (https://stellar-portal.github.io/campaign-tracker/), no build step.
  - Cache-busting `?v=YYYYMMDDx` on every import. Bump it everywhere with `grep -rl OLD --include=*.js --include=*.html . | xargs sed -i 's/OLD/NEW/g'`.
- Back end: Supabase project `vmzbpuootzchpdnvtfhb` (StellarCRM, eu-west-1).
- Brand colour is cobalt `#0f25bf` (`--accent`). Design rules are in DESIGN.md.
- Git: `git pull --rebase` before every push.

## Scheduled jobs (pg_cron → Edge Functions, times in UTC)
| Job | Schedule | Function | What it does |
|---|---|---|---|
| sheet-sync | every minute | `sheet-sync` | Pushes queued campaign changes (`campaign_sheet_sync`) to the Campaign Overview sheet via the Apps Script web app. |
| overview-pull | every 5 min | `sheet-sync` `{action:pull_overview}` | Reads the whole sheet tab into `overview_snapshot`, then `pullEdits` copies sheet edits into linked campaigns. |
| daily-stats-refresh | */5, 02:00–04:55 | `refresh-stats` | ScrapeCreators (TikTok) and the YouTube API, in batches. One fetch per video per day; skips campaigns ended more than 30 days ago. |
| roster-refresh | 03:40 | `roster` | Refreshes roster creators' stats. |
| trending-charts | */5, 04:00–05:55 | `chartmetric-sync` | Spotify Top 200 and Shazam per `trend_countries` row → `trend_chart_rows` → `trend_scores`, momentum and signals. |
| fx-rates | 05:20 | `fx-rates` | ECB rates → `fx_rates`. All totals are converted to USD. |

## On-demand functions
- `process-links`: pasted TikTok/YouTube links → posts (ScrapeCreators).
- `share`: token-checked client report data.
- `artist-search`: Chartmetric (1 credit per search), falls back to Deezer.
- `creator-insights`: creator audience (Chartmetric/ScrapeCreators, cached 30 days).
- `discover`: Influencers.club. That account currently has no credits.
- Secret names only: SCRAPECREATORS_API_KEY, YOUTUBE_API_KEY, CHARTMETRIC_REFRESH_TOKEN, INFLUENCERS_CLUB_API_KEY. The sheet web-app URL and secret are in `private.settings` (`sheet_sync_url`, `sheet_sync_secret`).
- `fx-rates` is deployed, but its source isn't in `supabase/functions/`. Most migrations were applied through the Supabase tools, so `supabase/migrations/` is incomplete. The live database is the truth.

## Campaign Overview sheet sync (the riskiest part)
- Spreadsheet `1e3ce1Q7uW5iH4FQqN9Oo_Dw5Y51UcBx87nOAz1wp6Tk`, tab found by its **name**: "Copy of CAMPAIGN OVERVIEW FY26/27".
- Layout: headers in row 2, example in row 3, data from row 4. Script: `sheets/CampaignOverviewSync.gs`, which lives inside the sheet.
- How rows link to campaigns:
  - A hidden Developer Metadata tag `stellar_campaign_id` on the row.
  - If there's no tag, Artist + Song + PO.
  - A new campaign takes the first empty row.
- Two-way sync: a sheet edit that differs from `campaign_sheet_sync.sheet_fields` gets copied into the campaign. If the campaign also has a pending platform edit, **the platform wins** and overwrites the row.
- What the OS never writes in the sheet: invoicing columns, Comments, posts/deliverables columns, formula cells. Deleting a campaign leaves its row alone.
- Recreated tab: same name and layout means it keeps working. Missing rows are re-added only on the next change. Pasted-in values flow *into* the OS.
- New spreadsheet file: redeploy the script there, update SPREADSHEET_ID, and save the new web-app URL in `private.settings`.

## Data model essentials
- `campaigns` → `posts` → `post_daily_stats` / `post_latest_stats`; `campaign_sounds`, `campaign_markets` (16 markets), `campaign_folders`.
- `campaign_summary` view (security_invoker): spend = `creator_costs` + `payout_rows`.
- Payouts: `payout_sections` and `payout_rows`. Statuses: contacted, waiting_draft, drafted, waiting_payment (shown as "Waiting to post"), posted ("Posted · to pay", set automatically when all commissioned videos are in the tracker), paid. Rows link to creators by `creator_id` (exact handle match, or the "Same person" suggestion for near-misses). Any two of videos / price per video / total compute the third. "Sourced & paid by" only offers the campaign's runners (`campaigns.campaign_runner`, comma-separated team names) and DRI. Margin on the tab = invoiced budget − creator costs.
  - **Creator budget** = `campaigns.spend_cap_percent` (default 30) × budget, and it's a hard limit.
- Invoices: `invoice_requests`, statuses requested, returned, invoiced, paid, cancelled.
  - A trigger syncs `campaigns.invoiced`.
  - Roles live in `team_members.role` (admin/finance/member), checked with `private.is_finance()`; RPC `set_team_member` is admin only.
  - Invoices are actually sent from e-conomic. The integration isn't built yet: it's waiting on Sam's app approval (Sales role only for now).
- Artist pictures: `artists` (name_key, image_url, cm_artist), filled by `artist-search` when a campaign is created or edited. The overview auto-looks-up missing ones (exact name match, max 25 per session).
- Share links: `share_links`, with settings per category; folders can be hidden.
- Folders show creators, not uploads: creators with videos in the folder plus `campaign_folder_creators` (added by profile link via the `roster` function's `lookup` action (TikTok: profile only, 1 ScrapeCreators credit; never puts them on the roster)).
- `posts.boost_code` (+ `_updated_at`, `_by`): TikTok Spark Ads code per video, team only; the `share` function selects explicit columns and never sends it.
- Creator avatars are copied to the `avatars` bucket by both `roster` and `process-links` (TikTok's own links expire).

## Front-end map
- `app.js`: router, nav and page cache. Desktop menu is icons-only and opens almost instantly on hover (120ms) and pushes the page aside (never covers it), closing 150ms after the pointer leaves or on a click in the page (`navPeek`); Ctrl/⌘+\\ toggles it. Phones keep the top bar.
  - Page cache: KEEPABLE hashes stay in the DOM for 3 minutes and are cleared on any write.
  - Also: overview (`renderOverview`), campaign page (`renderCampaign`: Report/Payouts tabs switch in place, share dialog, ⋯ menu), campaign form, folders.
- Pop-ups: one app-wide handler (`closePopups` in app.js) closes them on an outside click or Escape. Menus/dropdowns built as `<details>` must be listed in `POPUP_DETAILS`; button-opened panels get `data-pop` and `aria-controls` on their button. Modal `<dialog>`s close on a click on the dimmed backdrop.
- Artist banners (`.art-band`) are rounded floating cards; on the campaign page the details card overlaps the banner's bottom.
- `report.js`: charts and post wall, shared with the client view. Charts show all four metrics by default and start at zero ("Posted"/"Start") so a line appears from the first check. The video preview drives TikTok's embed with `controls=0` and its postMessage API (own play/seek/mute bar); switching tabs never reloads the video.
- `payouts.js`, `invoices.js`, `analytics.js` (tabs, zoom routes `#/analytics/<kind>/<value>`), `trending.js`, `roster.js`, `discover.js`.
- Tests are throwaway Playwright scripts with mocked REST, kept in the session scratchpad and not in the repo. Check every change at 1440px and 390px for zero horizontal overflow and zero page errors.
