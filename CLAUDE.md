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
4. **Move hosting off GitHub Pages** to something more official (Cloudflare Pages, Vercel or similar, ideally on a Stellar domain). Sam doesn't want "github" in the dashboard link. Note: the client and deck links change with the domain.
5. **Bring the Live Marketing portal and the Advocates Portal into the OS**, and find a way to fit their ad-hoc ways of working alongside the OS's campaign setup (e.g. the Jhené Aiko campaign already in the tracker).
6. **Connect Stellar's own clipping platform** (built separately, not in this repo): clients buy a clipping campaign in-platform; clippers join and are paid by their share of the campaign's views goal. Decide how its campaigns, spend and views show up in the OS.
7. **Legal and security check** (from two checklists Sam shared). Legal: privacy policy, terms, cookie policy + consent banner, form consents, collect no unnecessary data, audit third-party scripts, no dark patterns or hidden fees, alt text, colour contrast, keyboard navigation, business details, age consent, unsubscribe links in emails, font/image licences, data-deletion requests. Security: unused packages, secrets in git history, rate limiting, user access (RLS), password handling (Supabase Auth), hidden API keys, auth, dependency updates, form sanitising, XSS, no debug mode, full audit, env variables, exposed files, admin-only routes, API endpoints, CORS, security headers, database access.
8. **Slim down the code (refactor):** remove dead code, duplicate helpers, unused CSS and leftovers (e.g. the unused `.pm-shield` styles) so the files are lighter. No feature may be lost, and the app must behave and feel exactly as it does now: test every page before and after.
9. **Clients section:** one list of client companies with their people (emails, market West/Central/East, invoicing details). Campaigns pick the client from it (no more "Sony" vs "Sony Music Entertainment"); a client page shows their campaigns, invoices and deck views; deck viewers are matched to companies by email.
10. **Campaign chat rooms via Slack:** one chat room per campaign between the people on it (runners + DRI), connected to Slack and shown in the campaign dashboard.
11. **Gmail and Google Calendar per team member:** an optional personal connector each team member can switch on in Stellar OS.
12. **Personal to-do list (opt-in, per team member):** built from the campaigns they're DRI on or running, and from the payout sheets they're assigned to (creators they're reaching out to / collecting content from). Weekly recap every Friday 17:00 Copenhagen time: what was completed (crossed off) and double-checks on things that should be done. AI reads emails and turns them into actions (e.g. "proposal for campaign X with 3 options by EOW / EOD / a set day", "start campaign X", "set up a call for this thread on day X"). Helpful, not overly specific.
13. **Proposals and pitched campaigns:** a proposal builder with a database, tied to each campaign Stellar pitches and sells; plus a "Pitched" section for campaigns that aren't in the Campaign Overview yet.

## Stack
- Front end: static ES modules on GitHub Pages (https://stellar-portal.github.io/campaign-tracker/), no build step.
  - Cache-busting `?v=YYYYMMDDx` on every import. Bump it everywhere with `grep -rl OLD --include=*.js --include=*.html . | xargs sed -i 's/OLD/NEW/g'`.
- Back end: Supabase project `vmzbpuootzchpdnvtfhb` (StellarCRM, eu-west-1).
- Brand colour is cobalt `#0626c7` (`--accent`). Design rules are in DESIGN.md.
- Git: `git pull --rebase` before every push.

## Scheduled jobs (pg_cron → Edge Functions, times in UTC)
| Job | Schedule | Function | What it does |
|---|---|---|---|
| sheet-sync | every minute | `sheet-sync` | Pushes queued campaign changes (`campaign_sheet_sync`) to the Campaign Overview sheet via the Apps Script web app. |
| overview-pull | every 5 min | `sheet-sync` `{action:pull_overview}` | Reads the whole sheet tab into `overview_snapshot`, then `pullEdits` copies sheet edits into linked campaigns. |
| daily-stats-refresh | */5, 02:00–04:55 | `refresh-stats` | ScrapeCreators (TikTok) and the YouTube API, in batches. One fetch per video per day; skips campaigns ended more than 30 days ago. |
| roster-refresh | */10, 01:00–03:50 | `roster` | Refreshes roster creators' stats (25 due creators per run, so CSV imports fill in within a night or two). |
| trending-charts | */5, 04:00–05:55 | `chartmetric-sync` | Spotify Top 200 and Shazam per `trend_countries` row → `trend_chart_rows` → `trend_scores`, momentum and signals. |
| deck-notify | every 2 min | `deck-notify` | Slack summary for each finished deck view. |
| fx-rates | 05:20 | `fx-rates` | ECB rates → `fx_rates`. All totals are converted to USD. |

## On-demand functions
- `process-links`: pasted TikTok/YouTube links → posts (ScrapeCreators).
- `share`: token-checked client report data.
- `deck-view`: public side of tracked deck links (`deck.html#t=<token>`): `status`, `open` (email gate, signed 180-day viewer pass, slide/video links signed for 2h from the private `deck-media` bucket, signed-in team not tracked), `track` (signed session id → `deck_merge`, running totals so resends never double-count). Rate-limited via `deck_rate_ok` on a hashed IP; the IP is never stored. `deck.html` loads no outside fonts or scripts. `privacy.html` is the public privacy policy (Stellar Marketing ApS).
- `deck-import` (team only): builds a deck version from Figma Slides. Figma's REST API can't list what's inside a Slides file, so the slide list, links and video boxes come from the **"Send to Stellar OS" Figma button** (`figma-plugin/`, zipped as `send-to-stellar-os.zip`, rebuild the zip when its files change). Auth: the button sends a personal key (`deck_plugin_keys`, only a SHA-256 hash stored; made in Decks → Figma button); the OS sends the user's session. Slides are rendered by Figma (`/images`, `use_absolute_bounds=true`, so no white frame). TikTok videos (ID from the Snaptik layer name) are downloaded once via ScrapeCreators and reused on later versions; videos inside phone mockups keep their crop (`deck_spots.clip`). Sending the same file again makes a new version of the same deck. Needs the `FIGMA_TOKEN` secret (expires; date in `private.settings.figma_token_expires`, shown on Decks and as an OS-wide reminder in the last 14 days).
- `deck-view` email codes: a link with `verify_email` asks for a 6-digit code sent by email (Resend, secret `RESEND_API_KEY`, sender `DECK_EMAIL_FROM`, default noreply@stellarmusic.dk (live value set by the DECK_EMAIL_FROM secret); `deck_email_codes` keeps only hashes, 15 min, 5 tries). Without the secret those links fall back to a plain email gate. Sessions record `verified`.
- `deck-notify` (pg_cron `deck-notify`, every 2 min): one Slack message per deck view, 3 minutes after the viewer leaves (who, deck, link, time, slides, top slide, links opened). Secret `SLACK_DECKS_WEBHOOK` (Slack incoming webhook); without it, it does nothing. Marks `deck_sessions.notified_at`.
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
- CSV import (`creator-import.js`, "Import CSV" on the roster): RPC `import_creators(p_rows, p_list)` (team only, max 5,000 rows) adds creators by platform + handle with no credits used; `creators.contact_email` holds the email. Imported rows have no `tiktok_user_id` until their first refresh; the AFTER INSERT trigger `creators_merge_import` folds a placeholder into the real row if `add` inserts it again (lists, folders, payouts, costs, posts move over). "Fetch their numbers now" calls `roster` `add` per new creator.
- Creator avatars are copied to the `avatars` bucket by both `roster` and `process-links` (TikTok's own links expire).

## Front-end map
- `app.js`: router, nav and page cache. Desktop menu is icons-only and opens almost instantly on hover (120ms) and pushes the page aside (never covers it), closing 150ms after the pointer leaves or on a click in the page (`navPeek`); Ctrl/⌘+\\ toggles it. Phones keep the top bar.
  - Page cache: KEEPABLE hashes stay in the DOM for 3 minutes and are cleared on any write.
  - Also: overview (`renderOverview`), campaign page (`renderCampaign`: Report/Payouts tabs switch in place, share dialog, ⋯ menu), campaign form, folders.
- Pop-ups: one app-wide handler (`closePopups` in app.js) closes them on an outside click or Escape. Menus/dropdowns built as `<details>` must be listed in `POPUP_DETAILS`; button-opened panels get `data-pop` and `aria-controls` on their button. Modal `<dialog>`s close on a click on the dimmed backdrop.
- Artist banners (`.art-band`) are rounded floating cards; on the campaign page the details card overlaps the banner's bottom.
- `report.js`: charts and post wall, shared with the client view. Charts show all four metrics by default and start at zero ("Posted"/"Start") so a line appears from the first check. The video preview drives TikTok's embed with `controls=0` and its postMessage API (own play/seek/mute bar), autoplays muted, and crops TikTok's header and like/comment/share column out of view (iframe enlarged and shifted, see styles.css); switching tabs never reloads the video.
- `decks.js`: Decks section (#/decks, #/decks/<id>): deck list, links (on/off, expiry), views with seconds per slide, upload for missing videos, Figma button setup and keys, token countdown.
- `payouts.js`, `invoices.js`, `analytics.js` (tabs, zoom routes `#/analytics/<kind>/<value>`), `trending.js`, `roster.js`, `discover.js`.
- Tests are throwaway Playwright scripts with mocked REST, kept in the session scratchpad and not in the repo. Check every change at 1440px and 390px for zero horizontal overflow and zero page errors.
