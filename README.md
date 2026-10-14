# Stellar Campaign Tracker

Internal tool for the Stellar team: create TikTok campaigns, paste creator links, and track plays, likes, comments, shares, spend and cost per view.

- **Front end:** these static files, served by GitHub Pages. No build step.
- **Back end:** Supabase project `StellarCRM`: database, team logins, cover storage, and the `process-links` Edge Function that looks links up through ScrapeCreators.
- **Daily refresh:** the `refresh-stats` Edge Function runs every 5 minutes between 04:00 and 06:55 Copenhagen time (03:00–05:55 in winter). Each run collects the next batch of videos and sounds in active campaigns that don't have today's numbers yet, so no video is paid for twice in a day. Campaigns stop being refreshed 30 days after their end date. "Refresh numbers" on a campaign page runs it for that campaign on demand, skipping anything checked in the last hour.
- **Client links:** "Share with client" on a campaign page creates one private link per artist (`share.html#t=…`). It shows every non-draft campaign for that artist: totals with engagement rate, sounds, songs and countries over a chosen date range, plus the post wall. It never shows budgets, spend, margins or creator payment details. The `share` Edge Function checks the token and returns only those fields; turning the link off makes it stop working immediately.
- **Access:** only signed-in users whose email is in the `team_members` table can see or change anything. Every table is protected by row level security.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page shell |
| `app.js` | All screens: sign in, campaign list, campaign form, campaign dashboard, add links |
| `styles.css` | Styles |
| `assets/` | Stellar logo in white and blue |
| `share.html`, `share.js` | The client report behind a share link (no login) |
| `config.js` | Supabase project URL and publishable key (safe to publish) |
| `vendor/supabase.esm.js` | Supabase JavaScript client v2.45.4, bundled so the app needs no CDN |

## Adding a team member

1. Supabase → Authentication → Users → Add user, with their email and a password.
2. Supabase → SQL Editor: `insert into team_members (email, name) values ('name@stellarmusic.dk', 'Name');`
