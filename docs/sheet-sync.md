<!-- Moved out of CLAUDE.md on 2026-11-27 to keep session start small. Read when a task touches this area; keep it up to date. -->
# Campaign Overview sheet sync (the riskiest part)
- Spreadsheet `1e3ce1Q7uW5iH4FQqN9Oo_Dw5Y51UcBx87nOAz1wp6Tk`, tab found by its **name**: "Copy of CAMPAIGN OVERVIEW FY26/27".
- Layout: headers in row 2, example in row 3, data from row 4. Script: `sheets/CampaignOverviewSync.gs`, which lives inside the sheet.
- How rows link to campaigns:
  - A hidden Developer Metadata tag `stellar_campaign_id` on the row.
  - If there's no tag, Artist + Song + PO.
  - A new campaign takes the first empty row.
- Two-way sync: a sheet edit that differs from `campaign_sheet_sync.sheet_fields` gets copied into the campaign. If the campaign also has a pending platform edit, **the platform wins** and overwrites the row.
- What the OS writes in the sheet: "Invoicing Entity" (kept in step with the campaign's company), "Campaign Cost" and "Margin" from real spend (`campaign_sheet_rows.cost` = `campaign_summary.spend`; shown only once the tracker knows some spend, otherwise the sheet keeps what the team typed). A payout change sends just these two columns (`campaign_sheet_sync.cost_only`), so a sheet edit made in the same minutes isn't overwritten.
- It never writes the other invoicing columns, Comments, posts/deliverables columns or formula cells. Deleting a campaign leaves its row alone.
- Recreated tab: same name and layout means it keeps working. Missing rows are re-added only on the next change. Pasted-in values flow *into* the OS.
- New spreadsheet file: redeploy the script there, update SPREADSHEET_ID, and save the new web-app URL in `private.settings`.
