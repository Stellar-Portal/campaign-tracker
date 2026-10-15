# Stellar OS

Stellar's internal platform. A sidebar links its sections: **Campaign overview** (the backlog, from the Campaign Overview sheet), **Tracker** (TikTok campaigns: paste creator links, track plays, likes, comments, shares, spend and cost per view), and the planned **PayPal payouts**, **Creator payments**, **Invoices** and **Analytics** (placeholders for now; add them in `NAV` and `SOON` in `app.js`).

- **Front end:** these static files, served by GitHub Pages. No build step.
- **Back end:** Supabase project `StellarCRM`: database, team logins, cover storage, and the `process-links` Edge Function that looks links up through ScrapeCreators.
- **Daily refresh:** the `refresh-stats` Edge Function runs every 5 minutes between 04:00 and 06:55 Copenhagen time (03:00–05:55 in winter). Each run collects the next batch of videos and sounds in active campaigns that don't have today's numbers yet, so no video is paid for twice in a day. Campaigns stop being refreshed 30 days after their end date. "Refresh numbers" on a campaign page runs it for that campaign on demand, skipping anything checked in the last hour.
- **Client links:** "Share with client" on a campaign page creates one private link per artist (`share.html#t=…`). It shows every non-draft campaign for that artist: totals with engagement rate, sounds, songs and countries over a chosen date range, plus the post wall. It never shows budgets, spend, margins or creator payment details. The `share` Edge Function checks the token and returns only those fields; turning the link off makes it stop working immediately. Each link has settings (which tabs, charts, campaigns, creator country and follower counts the client sees); the function leaves out anything switched off, so it never reaches the client's browser. There is no setting for money. "Client view" on a campaign page shows the team the same report with everything on.
- **Campaign Overview sheet:** every campaign with a PO number is written to the "Copy of CAMPAIGN OVERVIEW FY26/27" tab (set by SHEET_GID and SHEET_NAME in the script). Artist + song + PO identify the row; a new campaign takes the first empty "Select" row. Any change to a campaign, its market splits or its creator costs queues it (`campaign_sheet_sync`), and the `sheet-sync` Edge Function sends it within about a minute through an Apps Script web app inside the sheet (`sheets/CampaignOverviewSync.gs`). The tracker owns sections 1–3, Campaign Cost and Margin (only once creator costs are recorded) and the Budget Allocation columns; it never writes invoicing, Comments, the posts/deliverables columns or any cell with a formula. Deleting a campaign leaves its sheet row alone. The web app URL and shared secret live in `private.settings`, never in this repo.
- **Campaign overview page:** the `sheet-sync` function copies every filled-in row of the sheet tab into `overview_snapshot` every 5 minutes (and on "Refresh from sheet"). Rows are matched to tracker campaigns by Artist + Song + PO; matched rows link to the campaign, the rest have "Create", which opens the campaign form filled in from the row (status, client details, dates, price, PO, budget allocations as markets). Saving it makes the tracker keep that row up to date. Invoicing columns are read-only here.
- **Markets and folders:** markets are the sheet's 16 allocation columns (`markets` table), split by % or by amount. A campaign can get a folder per market automatically, or folders named by hand (e.g. per creative). Every post can sit in one folder; folders never change the campaign's totals. A folder can be hidden from client links (its posts still count, just unnamed) and can have its own client link that shows only that folder's posts and numbers.
- **Access:** only signed-in users whose email is in the `team_members` table can see or change anything. Every table is protected by row level security.

## Design

The look follows `DESIGN.md`: Apple's design language from [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT), with Stellar cobalt as the single accent colour and the Stellar logo kept. AI coding tools read that file, so new screens stay consistent; change the Stellar section at the top of it to change the rules.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page shell |
| `app.js` | All screens: sign in, campaign list, campaign form, campaign dashboard, add links |
| `styles.css` | Styles, following `DESIGN.md` |
| `assets/` | Stellar logo in white and blue |
| `report.js` | The report itself (charts, post wall, preview window), shared by the client link and the team's Client view |
| `share.html`, `share.js` | The client report behind a share link (no login) |
| `sheet-lists.js` | Dropdown values shared with the Campaign Overview sheet, and PO number formatting |
| `sheets/CampaignOverviewSync.gs` | The Apps Script that lives in the Campaign Overview sheet (the secret is filled in there, not here) |
| `config.js` | Supabase project URL and publishable key (safe to publish) |
| `vendor/supabase.esm.js` | Supabase JavaScript client v2.45.4, bundled so the app needs no CDN |

## Adding a team member

1. Supabase → Authentication → Users → Add user, with their email and a password.
2. Supabase → SQL Editor: `insert into team_members (email, name) values ('name@stellarmusic.dk', 'Name');`
