# Stellar OS: quick map for Claude

Read this first. It is kept short on purpose (it loads at the start of every session and every agent): the details live in `docs/` and are read only when a task needs them. README.md has the long, human version. Nothing here or in `docs/` holds secrets: the repo is public.

## Ground rules (from Sam)
- Clients never see budgets, spend, margins, payouts or creator costs. The `share` function is the only thing clients reach, and it must never read those tables.
- Secrets live in Supabase secrets or `private.settings`. They never go in the repo or in chat. Don't commit the sheet secret.
- Database changes are additive only: no column or table drops. New tables get RLS (`private.is_team_member()`) and explicit grants to `authenticated`.
- No destructive actions, purchases, account creation or password entry without Sam's explicit OK.
- Regions are named **West** (Americas), **Central** (Europe, Africa, Middle East up to Russia) and **East** (Asia incl. Japan and Australia). Keep those names.
- Copy style: plain words, no jargon, in-app dialogs (`dialog.js` `confirmDialog`). Never use `confirm()` or `prompt()`.

## Agents (`.claude/agents/`, set up 2026-11-26 at Sam's ask)
The main session plans, talks to Sam and commits; it hands work to the cheapest agent that can do it well:
- **scout** (Haiku, low): read-only lookups in code and live data.
- **docs-keeper** (Haiku, medium): CLAUDE.md, pending list, Obsidian vault, cache bumps, migration files.
- **tester** (Sonnet, medium): Playwright at 1440/390 with mocks, CSP smoke, screenshots.
- **builder** (Sonnet, high): features in existing patterns, automations, the code slim-down.
- **architect** (Opus, high): schema/RLS/RPCs, money (invoices, PayPal, payouts), sheet sync, security/privacy, plans and reviews of builder's work.
**Use agents sparingly (Sam, 2026-11-27: they use too much):** small or single-file changes, quick lookups, cache bumps, CLAUDE.md edits and one-off checks are done in the main session. Start an agent only when the work is big enough to pay for its cold start (a multi-file feature, a schema/money change that needs a careful second look, a full test pass before a big push), and give it one complete brief instead of several small agents. Skip the extra review/test agent when the change is small and already checked. Prefer the cheapest model that does it well; never run parallel agents just to save time.
Rough split of the pending list: builder = 1, 2, 7, 10, 15, 16 and UI parts of 4, 11, 12; architect = 5, 6, 9, 13, 14 and the data side of 4 and 11. Agents never commit or push. Each agent brief names the `docs/` files the agent needs; agents don't read the others.

## Where the details are (read only what the task touches)
- `docs/pending.md`: full notes for each pending item below.
- `docs/stack.md`: hosting, Cloudflare, CSP (`_headers`), fonts, privacy tools, cache-busting.
- `docs/jobs.md`: scheduled jobs (pg_cron).
- `docs/functions.md`: every Edge Function (share, deck-view, creator-portal, vendor-form, paypal-payouts, posts-watch, notify-email, todo, …) and the secret names.
- `docs/sheet-sync.md`: the Campaign Overview sheet sync (the riskiest part: read it before touching anything sheet-related).
- `docs/data-model.md`: tables, views, RPCs and triggers (payouts, invoices, invoice plan, money flags, alerts, clients, creators, PayPal).
- `docs/frontend.md`: which file draws which screen, and UI conventions (pop-ups, page cache, chat, to-do).
- When something changes, update the matching `docs/` file, not this one. Add here only rules from Sam and the pending list.

## Essentials
- Live at **https://os.stellarmusic.dk** (Cloudflare Pages, auto-deploys from `main`; static ES modules, no build step). Supabase project `vmzbpuootzchpdnvtfhb`; the live database is the truth (`supabase/migrations/` is incomplete).
- Strict CSP: own scripts only, no inline handlers, no `javascript:` links, no third-party scripts or fonts (details in `docs/stack.md`).
- Cache-busting `?v=YYYYMMDDx` on every import; bump it everywhere with `grep -rl OLD --include=*.js --include=*.html . | xargs sed -i 's/OLD/NEW/g'`.
- `git pull --rebase` before every push.
- Tests are throwaway Playwright scripts with mocked REST, kept outside the repo. Check every UI change at 1440px and 390px for zero horizontal overflow and zero page errors.

## Pending fixes (Sam's to-do list)
Sam asked: keep these until he asks to solve them, and **list them every time he asks to build or fix something else**. Remove an item only once it's done (here and in `docs/pending.md`). Numbers are Sam's; 8 was removed.
1. **Post watcher:** built and switched off (`posts-watch`); needs Sam's OK to schedule (about 1 ScrapeCreators credit per creator per day) and one dry run.
2. **Cheaper audience lookup:** buy only Influencers.club "Analytics" (0.8) or "Profile" (0.2) instead of "Full" (1).
3. **Influencers.club top-up** only for vetting on the payout sheet and lookalike shortlists (account has no credits).
4. **Live Marketing portal and Advocates Portal into the OS** (Live Marketing's campaigns first, then the Advocates' monthly quota).
5. **Connect Stellar's clipping platform** (decide how its campaigns, spend and views show up).
6. **Security leftovers** from 2026-11-14 (leaked-password switch, deck data clean-up schedule, lawyer review of `privacy.html`, supabase-js update, artist photos into own storage, repo public or not, pg_net schema).
7. **Slim down the code** (dead code, duplicates, unused CSS; nothing may change for users).
9. **Gmail and Google Calendar per team member** (internal Google Workspace app).
10. **To-do next steps** (automatic tasks from campaigns, sharing, "popped up while away", email → suggested tasks).
11. **Proposals and pitched campaigns** (proposal builder + "Pitched" section).
12. **Clients leftovers** for Sam to sort (Atlantic/Virgin duplicates, Warner APAC vs China HK, test company "fghjkl", JG Music).
13. **PayPal go-live** (built, sending OFF; Sam's OK, then Sam sends the first small real payment).
14. **Money flow phases 2–4** (on hold / didn't run + credit notes, Monday DRI email, quarterly check).
15. **Creator page follow-ups** (real draft upload test, when to delete draft videos).
16. **Declutter the whole OS** (fewer helper notes, clearer pages; page by page with Sam's OK).
17. **Analytics on real money** (payouts and invoice requests instead of the sheet's typed numbers, plus a quarter view).

## Standing decisions
- **Decided 2026-11-26 (Sam):** client weekly update emails stay written by a person (not built). No ⌘K search. The Business view is item 17. Pending item 8 (campaign chat → Slack) dropped 2026-11-27.
- **Privacy reminder (Sam's ask):** whenever a feature sends personal data to a new outside company (e.g. PayPal for creator payouts), remind Sam to add it to `privacy.html` and the lawyer review. Open now: PayPal (creators' PayPal emails and amounts); creators' payment details (full name, country, PayPal email/username) collected on `payment-details.html`: `privacy.html` needs a creators section; client/vendor contacts (company details, contact name and email, signature) collected on `vendor-form.html` and emailed via Resend: `privacy.html` needs a clients/vendors section; creators' draft videos (they show the creator) are stored in our Supabase storage and, with client review on, shown to the client: the creators section must cover drafts and how long they're kept. Alert emails (`notify-email`, switched off): team alerts carry creator handles and client contact names, sent via Resend: `privacy.html` needs a team members section (Resend as processor).
- **Creator payment details live on the roster card, never in a separate section (Sam, 2026-11-24).** The old Google Form answers will NOT be imported (Sam, 2026-11-25): instead each campaign's Payouts tab has "Links for missing details" (one personal link per creator without PayPal/Wise details, copied as "@handle: link" lines). Wise on the creator's one-time form later.
- **Archive, don't delete:** Completed = the archive (Tracker filter "Completed (archive)"). A campaign with a money trail (any PayPal payment, an invoice request that isn't cancelled, a creator marked paid) can't be deleted: `deleteCampaignFlow` and the overview's delete use `moneyTrail()` and offer `archiveInstead()` (sets status `finished`). Campaigns and folders made by mistake (no money trail) can still be deleted. DB backstop: trigger `campaigns_keep_money_trail` (BEFORE DELETE, applied 2026-11-24) refuses deleting a campaign with non-cancelled invoice requests or paid payout rows; PayPal payments block it via FK.
