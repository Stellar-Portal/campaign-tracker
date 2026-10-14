# Stellar Campaign Tracker

Internal tool for the Stellar team: create TikTok campaigns, paste creator links, and track plays, likes, comments, shares, spend and cost per view.

- **Front end:** these static files, served by GitHub Pages. No build step.
- **Back end:** Supabase project `StellarCRM`: database, team logins, cover storage, and the `process-links` Edge Function that looks links up through ScrapeCreators.
- **Access:** only signed-in users whose email is in the `team_members` table can see or change anything. Every table is protected by row level security.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page shell |
| `app.js` | All screens: sign in, campaign list, campaign form, campaign dashboard, add links |
| `styles.css` | Styles |
| `config.js` | Supabase project URL and publishable key (safe to publish) |
| `vendor/supabase.esm.js` | Supabase JavaScript client v2.45.4, bundled so the app needs no CDN |

## Adding a team member

1. Supabase → Authentication → Users → Add user, with their email and a password.
2. Supabase → SQL Editor: `insert into team_members (email, name) values ('name@stellarmusic.dk', 'Name');`
