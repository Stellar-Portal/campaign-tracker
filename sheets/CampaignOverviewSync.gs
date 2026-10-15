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
const SHEET_GID = 1463586780;          // "CAMPAIGN OVERVIEW FY26/27"
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 4;              // row 3 is the worked example

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "Bad JSON" }); }
  if (!body || body.secret !== SECRET) return out({ ok: false, error: "Not allowed" });
  if (body.action === "ping") return out({ ok: true, sheet: getSheet_().getName() });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
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
  if (body.prev_key) idx = indexOf_(n, keyAt, body.prev_key);
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
  SpreadsheetApp.flush();
  return { ok: true, row: row, key: body.key, skipped: skipped, missing: missing };
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheets().find((s) => s.getSheetId() === SHEET_GID)
    || ss.getSheets().find((s) => /campaign overview fy26\/27/i.test(s.getName()));
  if (!sh) throw new Error("Campaign Overview FY26/27 tab not found");
  return sh;
}
function indexOf_(n, keyAt, key) { for (let i = 0; i < n; i++) if (keyAt(i) === key) return i; return -1; }
function key_(a, s, p) { return [a, s, p].map((x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ")).join("|"); }
function norm_(h) { return String(h || "").trim().toLowerCase().replace(/\s+/g, " "); }
function blank_(v) { v = String(v || "").trim(); return v === "" || v === "Select"; }
function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
