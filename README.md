# Stellar Campaign Tracker

Internal tool for the Stellar team: create TikTok campaigns, paste creator links, and track plays, likes, comments, shares, spend and cost per view.

- **Front end:** these static files, served by GitHub Pages. No build step.
- **Back end:** Supabase project `StellarCRM`: database, team logins, cover storage, and the `process-links` Edge Function that looks links up through ScrapeCreators.
- **Daily refresh:** the `refresh-stats` Edge Function runs every 5 minutes between 04:00 and 06:55 Copenhagen time (03:00–05:55 in winter). Each run collects the next batch of videos and sounds in active campaigns that don't have today's numbers yet, so no video is paid for twice in a day. Campaigns stop being refreshed 30 days after their end date. "Refresh numbers" on a campaign page runs it for that campaign on demand, skipping anything checked in the last hour.
- **Client links:** "Share with client" on a campaign page creates one private link per artist (`share.html#t=…`). It shows every non-draft campaign for that artist: totals with engagement rate, sounds, songs and countries over a chosen date range, plus the post wall. It never shows budgets, spend, margins or creator payment details. The `share` Edge Function checks the token and returns only those fields; turning the link off makes it stop working immediately. Each link has settings (which tabs, charts, campaigns, creator country and follower counts the client sees); the function leaves out anything switched off, so it never reaches the client's browser. There is no setting for money. "Client view" on a campaign page shows the team the same report with everything on.
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
| `config.js` | Supabase project URL and publishable key (safe to publish) |
| `vendor/supabase.esm.js` | Supabase JavaScript client v2.45.4, bundled so the app needs no CDN |

## Adding a team member

1. Supabase → Authentication → Users → Add user, with their email and a password.
2. Supabase → SQL Editor: `insert into team_members (email, name) values ('name@stellarmusic.dk', 'Name');`
