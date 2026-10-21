/**
 * Campaign Tracker → Campaign Overview sheet.
 *
 * Paste into the Campaign Overview spreadsheet (Extensions → Apps Script), set SECRET, then
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * The tracker posts one campaign at a time; this script finds its row by Artist + Song + PO
 * (or the first empty row) and writes only the columns the tracker owns.
 *
 * It never touches: invoicing (section 5), Comments, posts/deliverables columns, or any cell
 * that holds a formula.
 */
const SECRET = "PASTE_SECRET_HERE";
const SPREADSHEET_ID = "1e3ce1Q7uW5iH4FQqN9Oo_Dw5Y51UcBx87nOAz1wp6Tk";
// The tab is found by its NAME, so deleting and recreating it (which gives it a new hidden id) is fine
// as long as the name stays the same. The id is only a fallback for a renamed tab.
const SHEET_NAME = "Copy of CAMPAIGN OVERVIEW FY26/27";
const SHEET_GID = 349085962;
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 4;              // row 3 is the worked example
const TAG = "stellar_campaign_id";     // hidden tag on a row: which tracker campaign it belongs to.
                                       // It moves with the row when rows are inserted, sorted or renamed.

// Row of the campaign's tagged row, or 0.
function taggedRow_(sh, id) {
  if (!id) return 0;
  const found = sh.createDeveloperMetadataFinder().withKey(TAG).withValue(String(id)).find();
  for (const md of found) { const r = md.getLocation().getRow(); if (r) return r.getRow(); }
  return 0;
}
// Tag a row with a campaign (removing any older tag for that campaign or on that row).
function tagRow_(sh, row, id) {
  if (!id) return;
  sh.createDeveloperMetadataFinder().withKey(TAG).withValue(String(id)).find().forEach((md) => md.remove());
  sh.getRange(row + ":" + row).createDeveloperMetadataFinder().withKey(TAG).find().forEach((md) => md.remove());
  sh.getRange(row + ":" + row).addDeveloperMetadata(TAG, String(id));
}
// { rowNumber: campaignId } for every tagged row.
function tagMap_(sh) {
  const out = {};
  sh.createDeveloperMetadataFinder().withKey(TAG).find().forEach((md) => { const r = md.getLocation().getRow(); if (r) out[r.getRow()] = md.getValue(); });
  return out;
}

/** Run this once from the editor (choose "setup" and click Run) to give the script access to the sheet. */
function setup() {
  Logger.log('Connected to tab "' + getSheet_().getName() + '". You can close this.');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "Bad JSON" }); }
  if (!body || body.secret !== SECRET) return out({ ok: false, error: "Not allowed" });
  if (body.action === "ping") return out({ ok: true, sheet: getSheet_().getName() });
  if (body.action === "max_po") return out({ ok: true, max: maxPo_() });
  if (body.action === "export") return out(export_());

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (body.action === "delete_row") return out(deleteRow_(body));
    return out(upsert_(body));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function upsert_(body) {
  const sh = getSheet_();
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0].map(norm_);
  const col = (name) => headers.indexOf(norm_(name)) + 1;   // 1-based, 0 = missing

  const cArtist = col("Artist Name"), cSong = col("Song Name (s) or Project Name"), cPo = col("Stellar PO no."), cNum = col("#");
  if (!cArtist || !cSong || !cPo) throw new Error("Couldn't find the Artist, Song or PO column in row " + HEADER_ROW);

  const lastRow = Math.max(sh.getLastRow(), FIRST_DATA_ROW);
  const n = lastRow - FIRST_DATA_ROW + 1;
  const read = (c) => sh.getRange(FIRST_DATA_ROW, c, n, 1).getDisplayValues().map((r) => r[0]);
  const artists = read(cArtist), songs = read(cSong), pos = read(cPo);
  const keyAt = (i) => key_(artists[i], songs[i], pos[i]);

  // 1) the row we wrote last time (survives renames), 2) a row with the same key, 3) the first empty row
  let idx = -1;
  const tagged = taggedRow_(sh, body.campaign_id);
  if (tagged >= FIRST_DATA_ROW) idx = tagged - FIRST_DATA_ROW;
  if (idx < 0 && body.prev_key) idx = indexOf_(n, keyAt, body.prev_key);
  if (idx < 0) idx = indexOf_(n, keyAt, body.key);
  if (idx < 0) {
    for (let i = 0; i < n; i++) {
      if (blank_(artists[i]) && blank_(songs[i]) && blank_(pos[i])) { idx = i; break; }
    }
  }
  let row;
  if (idx >= 0) row = FIRST_DATA_ROW + idx;
  else {
    sh.insertRowAfter(lastRow);
    row = lastRow + 1;
    sh.getRange(lastRow, 1, 1, lastCol).copyTo(sh.getRange(row, 1, 1, lastCol), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    if (cNum) {
      const prev = Number(sh.getRange(lastRow, cNum).getValue());
      if (prev) sh.getRange(row, cNum).setValue(prev + 1);
    }
  }

  const formulas = sh.getRange(row, 1, 1, lastCol).getFormulas()[0];
  const skipped = [], missing = [];
  Object.keys(body.fields).forEach((name) => {
    const c = col(name);
    if (!c) { missing.push(name); return; }
    if (formulas[c - 1]) { skipped.push(name); return; }
    const f = body.fields[name];
    const cell = sh.getRange(row, c);
    if (f && typeof f === "object" && f.date) {
      const [y, m, d] = f.date.split("-").map(Number);
      cell.setValue(new Date(y, m - 1, d)).setNumberFormat("dd/mm");
    } else if (f && typeof f === "object" && "number" in f) {
      if (f.number === null) cell.setValue("");
      else cell.setValue(f.number).setNumberFormat(f.format || "#,##0.00");
    } else {
      cell.setValue(f === null || f === undefined ? "" : f);
    }
  });
  tagRow_(sh, row, body.campaign_id);
  SpreadsheetApp.flush();
  const after = sh.getRange(row, 1, 1, lastCol).getDisplayValues()[0];
  const hdr = sh.getRange(HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0];
  return { ok: true, row: row, key: body.key, skipped: skipped, missing: missing, headers: hdr, values: after, sheet: sh.getName() };
}

// Delete one campaign row, only if its Artist + Song + PO still match (so a shifted sheet can never
// lose the wrong row). body.keys: accepted keys; body.row: where the platform last saw it.
function deleteRow_(body) {
  const keys = (body.keys || []).filter((k) => k && k.replace(/\|/g, "").trim());
  const sh = getSheet_();
  const tagged = taggedRow_(sh, body.campaign_id);
  if (tagged >= FIRST_DATA_ROW) { sh.deleteRow(tagged); return { ok: true, row: tagged }; }
  if (!keys.length) throw new Error("Nothing identifies that row");
  const headers = sh.getRange(HEADER_ROW, 1, 1, sh.getLastColumn()).getValues()[0].map(norm_);
  const col = (name) => headers.indexOf(norm_(name)) + 1;
  const cA = col("Artist Name"), cS = col("Song Name (s) or Project Name"), cP = col("Stellar PO no.");
  const n = sh.getLastRow() - FIRST_DATA_ROW + 1;
  if (n < 1) throw new Error("The sheet has no campaigns");
  const read = (c) => sh.getRange(FIRST_DATA_ROW, c, n, 1).getDisplayValues().map((r) => r[0]);
  const a = read(cA), s = read(cS), p = read(cP);
  const keyAt = (i) => key_(a[i], s[i], p[i]);
  let idx = -1;
  const hint = Number(body.row) - FIRST_DATA_ROW;
  if (hint >= 0 && hint < n && keys.indexOf(keyAt(hint)) >= 0) idx = hint;
  else {
    const hits = [];
    for (let i = 0; i < n; i++) if (keys.indexOf(keyAt(i)) >= 0) hits.push(i);
    if (hits.length === 1) idx = hits[0];
    else if (hits.length > 1) throw new Error("More than one row matches; delete it in the sheet");
  }
  if (idx < 0) return { ok: true, row: null, note: "Row not found (already deleted?)" };
  sh.deleteRow(FIRST_DATA_ROW + idx);
  return { ok: true, row: FIRST_DATA_ROW + idx };
}

// Every filled-in row of the tab, as the sheet shows it, for the platform's Campaign Overview page.
function export_() {
  const sh = getSheet_();
  const lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  const sections = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  const headers = sh.getRange(HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0];
  const n = Math.max(lastRow - FIRST_DATA_ROW + 1, 0);
  const values = n ? sh.getRange(FIRST_DATA_ROW, 1, n, lastCol).getDisplayValues() : [];
  const col = (name) => headers.map(norm_).indexOf(norm_(name));
  const cA = col("Artist Name"), cS = col("Song Name (s) or Project Name"), cP = col("Stellar PO no.");
  const tags = tagMap_(sh);
  const rows = [];
  values.forEach((r, i) => {
    if (blank_(r[cA]) && blank_(r[cS]) && blank_(r[cP])) return;
    const row = FIRST_DATA_ROW + i;
    rows.push(tags[row] ? { row: row, values: r, cid: tags[row] } : { row: row, values: r });
  });
  return { ok: true, sheet: sh.getName(), sections: sections, headers: headers, rows: rows };
}

// Highest "#ST1234"-style PO number in the tab, as a number (0 if none).
function maxPo_() {
  const sh = getSheet_();
  const headers = sh.getRange(HEADER_ROW, 1, 1, sh.getLastColumn()).getValues()[0].map(norm_);
  const c = headers.indexOf(norm_("Stellar PO no.")) + 1;
  if (!c || sh.getLastRow() < FIRST_DATA_ROW) return 0;
  return sh.getRange(FIRST_DATA_ROW, c, sh.getLastRow() - FIRST_DATA_ROW + 1, 1).getDisplayValues()
    .map((r) => (String(r[0]).match(/ST\s*(\d+)/i) || [])[1])
    .filter(Boolean).map(Number).reduce((a, b) => Math.max(a, b), 0);
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tabs = ss.getSheets();
  const tidy = (x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
  const sh = ss.getSheetByName(SHEET_NAME)
    || tabs.find((t) => tidy(t.getName()) === tidy(SHEET_NAME))       // same name, different spacing/case
    || tabs.find((t) => t.getSheetId() === SHEET_GID);                  // renamed, but still the same tab
  if (!sh) throw new Error('Tab "' + SHEET_NAME + '" not found. Name the campaign tab exactly that (or update SHEET_NAME in the script).');
  // Never write into a tab with a different layout.
  const headers = sh.getRange(HEADER_ROW, 1, 1, sh.getLastColumn()).getValues()[0].map(tidy);
  if (headers.indexOf("artist name") < 0 || headers.indexOf("stellar po no.") < 0)
    throw new Error('Tab "' + sh.getName() + '" has no "Artist Name" / "Stellar PO no." headers in row ' + HEADER_ROW + '. Is it the campaign overview layout?');
  return sh;
}
function indexOf_(n, keyAt, key) { for (let i = 0; i < n; i++) if (keyAt(i) === key) return i; return -1; }
function key_(a, s, p) { return [a, s, p].map((x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ")).join("|"); }
function norm_(h) { return String(h || "").trim().toLowerCase().replace(/\s+/g, " "); }
function blank_(v) { v = String(v || "").trim(); return v === "" || v === "Select"; }
function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
