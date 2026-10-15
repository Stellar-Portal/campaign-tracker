// Values used by the Campaign Overview sheet, so what the tracker writes matches its dropdowns.
// Invoicing entities come from the sheet's "Invoicing Entity List" tab (October 2026); any other name can still be typed.
export const INVOICING_ENTITIES = ["Adam Hyde Productions", "Analogue Dawn", "Assemble Sound", "Avex Music Creative Inc.", "Awal Recordings Ltd", "Beautiful Noise", "Because Music Ltd", "Beggars Group", "Believe International", "Bell Partners AB (Sweden)", "Big Dog Business", "Big Loud Rock LLC", "BIGHIT MUSIC CO.", "BLCKLB PTE. LTD", "Business Music Inc.", "CBMG", "CMG Nettwerk Holdings LLC", "COHORT records PTY LTD ATF COHORT RECORDS UNIT TRUST", "Columbia Records", "Concord Label Group", "Dead Oceans", "Dorado Music Inc", "Echo Club Music Co.", "EMPIRE Distribution", "Encore Recordings LLC", "Forge Music Group", "Funfair Records", "FUTURES MUSIC GROUP", "Heatwave Records", "Hook Media Inc", "Jaye Funk", "Leonard Tefre Rasmussen", "LION BABE Music LLC", "MoBlack Records S.R.L.S.", "Modhaus Inc.", "MPMG MUSIC Co.", "Mr. Marco Zocco", "Namy& Inc.", "Nettwerk Music Group", "One World International LLC", "Pack Records Inc", "Pony Canyon Inc.", "Project A&R Pty Ltd", "Rancho Humilde Entertainment LLC", "Roc Nation LLC", "S10 Records", "Sadie Jean LLC", "Socios Music LLC", "Sony Music Entertainment (Japan) Inc", "Sony Music Entertainment France", "Sony Music Entertainment Germany GmbH", "Sony Music Latin (US)", "Sony Music Singapore", "Sorana Sorana LLC", "Spinnin' Records B.V.", "Stellar Music ApS", "TH3RD BRAIN Records LLC", "The Color Orange", "The Darkroom", "The Digilogue Group", "TheCarterB Corp", "Thirty Knots Inc", "Transparent Arts", "UMG Recordings Inc (US)", "Universal Music A/S (DK)", "Universal Music Australia", "Universal Music Canada", "Universal Music GmbH (Germany)", "Universal Music Group Mexico S.A. DE C.V.", "Universal Music LCC (Japan)", "Universal Music Operations (UK)", "Vastago Producciones LLC", "Verge Records dba ONErpm", "Virgin Music Group", "Vlast Co. Ltd.", "Vydia", "Warner Music APAC", "Warner Music Brasil Ltda.", "Warner Music Group Germany Holding GmbH (Germany)", "Warner Music Italy", "Warner Music Korea", "Warner Music Latina Inc. (US)", "Winning Team Music", "Zarpazo Records"];
export const CLIENT_COUNTRIES = ["US", "MX", "BR", "UK", "DE", "FR", "SP", "JP", "SG", "SEA", "AUS", "Hong Kong", "Sweden", "LATAM MX"];
export const CLIENT_MARKETS = ["Stellar West", "Stellar Central", "Stellar East"];
export const CAMPAIGN_TYPES = ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "Recurring"];
export const RELEASE_TYPES = ["New Release", "Catalogue", "Other"];
export const LABEL_TYPES = ["Major", "Indie", "Other"];
export const STATUSES = [["draft", "Upcoming"], ["active", "Active"], ["on_hold", "On hold"], ["finished", "Completed"]];
export const statusLabel = (s) => (STATUSES.find(([k]) => k === s) ?? [s, s ?? ""])[1];
// "ST2031", "st 2031", "2031" and "#ST2031" all become "#ST2031", the sheet's format.
export function normalisePO(v) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  const m = t.match(/^#?\s*(?:ST)?\s*-?\s*(\d+)$/i);
  return m ? `#ST${m[1]}` : t.toUpperCase();
}
