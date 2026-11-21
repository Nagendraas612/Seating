// Parses an uploaded student Excel file into student rows for Postgres.
//
// The college lists are messy in known ways, so the parser is forgiving:
// - the header row is FOUND by scanning (title rows sit above it, row 1
//   is almost never the header)
// - EVERY sheet is read (the lists split sections across sheets)
// - section comes from a SECTION column, or from the sheet name
//   ("A Section" / "B Sec" mean section A / B)
// - headers match case-insensitively, ignoring spaces and dots, so
//   "STUDENT NAME" and "Name" are the same column
//
// A row needs a USN, a name and an email to load. Rows missing one of
// those, and duplicate USN/email rows inside one file, are skipped and
// counted — never fatal. Blank rows are ignored, not counted.

const xlsx = require("xlsx");

// Header text -> column, after normalising (lowercase, no spaces/dots).
const HEADER_ALIASES = {
  usn: ["usn"],
  name: ["name", "studentname"],
  section: ["section", "sec"],
  batch: ["batch", "batchyear", "admissionyear"],
  email: ["email", "emailid", "emailaddress", "mail", "mailid"],
};

function normalizeHeader(cell) {
  return String(cell || "")
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, "");
}

// "A Section" / "B Sec" -> "A" / "B". Anything else (e.g. "All") -> null.
function sectionFromSheetName(name) {
  const m = String(name || "").trim().match(/^([A-Za-z])\s*(section|sec)\s*$/i);
  return m ? m[1].toUpperCase() : null;
}

function parseStudentWorkbook(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const students = [];
  const skipped = { noUsn: 0, noName: 0, noEmail: 0, dupUsn: 0, dupEmail: 0 };
  const seenUsn = new Set();
  const seenEmail = new Set();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (grid.length === 0) continue;

    // Find the header row: the first row (within the first 15) with a
    // cell that normalises to "usn". A sheet without one is not a
    // student list, so it is skipped.
    let headerRowIdx = -1;
    let colIdx = null;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const row = grid[i];
      const found = {};
      for (let j = 0; j < row.length; j++) {
        const norm = normalizeHeader(row[j]);
        for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
          if (aliases.includes(norm) && found[key] === undefined) found[key] = j;
        }
      }
      if (found.usn !== undefined) {
        headerRowIdx = i;
        colIdx = found;
        break;
      }
    }
    if (headerRowIdx === -1) continue;

    const sheetSection = sectionFromSheetName(sheetName);
    const cell = (row, key) =>
      colIdx[key] === undefined ? "" : String(row[colIdx[key]] ?? "").trim();

    for (let i = headerRowIdx + 1; i < grid.length; i++) {
      const row = grid[i];
      const usn = cell(row, "usn").toUpperCase();
      const name = cell(row, "name");
      const email = cell(row, "email").toLowerCase();
      // A row with nothing in it at all is not a student, just blank.
      if (!usn && !name && !email) continue;
      if (!usn) { skipped.noUsn++; continue; }
      if (!name) { skipped.noName++; continue; }
      if (!email) { skipped.noEmail++; continue; }
      if (seenUsn.has(usn)) { skipped.dupUsn++; continue; }
      if (seenEmail.has(email)) { skipped.dupEmail++; continue; }
      seenUsn.add(usn);
      seenEmail.add(email);
      const sectionRaw = cell(row, "section");
      students.push({
        usn,
        name,
        section: (sectionRaw || sheetSection || "").toUpperCase() || null,
        batch: cell(row, "batch") || null,
        email,
      });
    }
  }

  return { students, skipped };
}

module.exports = { parseStudentWorkbook, sectionFromSheetName };
