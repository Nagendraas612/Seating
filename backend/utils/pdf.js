// Refactored module (pure move from server.js): PDF generation helpers

const path = require("path");
const fs = require("fs");

// Logo file paths (resolved once)
const LOGO_VVCE = path.join(__dirname, "..", "assets", "vvce.jpg");
const LOGO_AIML = path.join(__dirname, "..", "assets", "aiml.jpg");

// Helper: Write PDF header (used by Notice Board & Attendance)
function writePDFHeader(doc, title, examName, date, session) {
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("AIML Department – Internal Examination", { align: "center" });
  doc.fontSize(14).text(title, { align: "center" });
  doc.moveDown(0.5);
  doc
    .fontSize(11)
    .font("Helvetica")
    .text(`Exam: ${examName}   |   Date: ${date}   |   Session: ${session}`, {
      align: "center",
    });
  doc.moveDown(1);
}

/**
 * Helper: Render the VVCE college letterhead at the top of the page.
 * Layout:
 *   [VVCE logo]   [Centered college name + accreditation + dept + contact]   [AIML logo]
 *
 * Returns the Y coordinate just below the header where content can start.
 */
function writeCollegeHeader(doc) {
  const pageWidth = doc.page.width;
  const margin = doc.page.margins.left;
  const startY = margin;
  const headerHeight = 80;
  const logoSize = 70;

  // Left logo (VVCE)
  try {
    if (fs.existsSync(LOGO_VVCE)) {
      doc.image(LOGO_VVCE, margin, startY, {
        fit: [logoSize, logoSize],
        align: "center",
        valign: "center",
      });
    }
  } catch (e) {
    console.warn("VVCE logo render failed:", e.message);
  }

  // Right logo (AIML)
  try {
    if (fs.existsSync(LOGO_AIML)) {
      doc.image(LOGO_AIML, pageWidth - margin - logoSize, startY, {
        fit: [logoSize, logoSize],
        align: "center",
        valign: "center",
      });
    }
  } catch (e) {
    console.warn("AIML logo render failed:", e.message);
  }

  // Centered college info block
  const textX = margin + logoSize + 10;
  const textWidth = pageWidth - 2 * margin - 2 * (logoSize + 10);
  let textY = startY + 2;

  doc
    .font("Helvetica")
    .fontSize(8)
    .text("Vidyavardhaka Sangha®, Mysore", textX, textY, {
      width: textWidth,
      align: "center",
    });
  textY = doc.y;

  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .text("VIDYAVARDHAKA COLLEGE OF ENGINEERING", textX, textY, {
      width: textWidth,
      align: "center",
    });
  textY = doc.y;

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .text(
      "Autonomous Institute, Affiliated to Visvesvaraya Technological University, Belagavi",
      textX,
      textY,
      { width: textWidth, align: "center" }
    );
  textY = doc.y;

  doc.text(
    "(Approved by AICTE, New Delhi & Government of Karnataka)",
    textX,
    textY,
    { width: textWidth, align: "center" }
  );
  textY = doc.y;

  doc.text("Accredited by NBA | NAAC with 'A' Grade", textX, textY, {
    width: textWidth,
    align: "center",
  });
  textY = doc.y;

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(
      "Department of CSE (Artificial Intelligence & Machine Learning)",
      textX,
      textY,
      { width: textWidth, align: "center" }
    );
  textY = doc.y;

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .text(
      "Phone: +91 821-4276326,  Email: hodaiml@vvce.ac.in",
      textX,
      textY,
      { width: textWidth, align: "center" }
    );
  textY = doc.y;

  doc.text("Web: http://www.vvce.ac.in", textX, textY, {
    width: textWidth,
    align: "center",
  });

  // Move past the header (whichever is taller: logo or text block)
  const endY = Math.max(startY + headerHeight, doc.y) + 5;
  doc.moveTo(margin, endY).lineTo(pageWidth - margin, endY).stroke();
  doc.y = endY + 8;
  return doc.y;
}

/**
 * Render one classroom (18 benches × 3 seats) in the template style.
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                  Seating Arrangement                        │
 *   │  CIE-II/I                          Room-No: B-212           │
 *   │                       Black-Board                           │
 *   │                          Board                              │
 *   │  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
 *   │  │ L  M  R  │  │ L  M  R  │  │ L  M  R  │  (strip 1)        │
 *   │  │ ...      │  │ ...      │  │ ...      │                   │
 *   │  │ 6 rows   │  │ 6 rows   │  │ 6 rows   │                   │
 *   │  └──────────┘  └──────────┘  └──────────┘                   │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Each strip = 6 benches = one "row" in the seating algorithm.
 * Each bench = 3 cells (left/middle/right), one USN per cell.
 */
function renderClassroom(doc, room, examName, semLabel) {
  const pageWidth = doc.page.width;
  const margin = doc.page.margins.left;
  const usableWidth = pageWidth - 2 * margin;

  // ── Title ───────────────────────────────────────────────────
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .text("Seating Arrangement", margin, doc.y, {
      width: usableWidth,
      align: "center",
    });
  doc.moveDown(0.3);

  // ── Exam name + semester (left) + Room number (centered) ──────────────
  const labelY = doc.y;
  const examLabel = semLabel ? `${examName || "—"}\n${semLabel}` : (examName || "—");
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(examLabel, margin, labelY, {
      width: usableWidth / 3,
      align: "left",
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(`Room-No: ${room.roomNo || "—"}`, margin, labelY, {
      width: usableWidth,
      align: "center",
    });
  doc.moveDown(0.6);

  // ── "Black-Board" / "Board" labels ─────────────────────────
  doc.font("Helvetica").fontSize(10).text("Black-Board", margin, doc.y, {
    width: usableWidth,
    align: "center",
  });
  doc.font("Helvetica-Bold").fontSize(12).text("Board", margin, doc.y, {
    width: usableWidth,
    align: "center",
  });
  doc.moveDown(0.5);

  // ── Build seating grid: 3 strips × 6 benches × 3 seats ─────
  // Each classroom = 18 benches total, split into 3 strips of 6.
  // Strip 1 = benches[0..5], Strip 2 = benches[6..11], Strip 3 = benches[12..17]
  const STRIPS = 3;
  const BENCHES_PER_STRIP = 6;
  const SEATS_PER_BENCH = 3;

  // Split seating array sequentially into 3 strips of 6
  const allBenches = room.seating || [];
  const stripBenches = [
    allBenches.slice(0, BENCHES_PER_STRIP),
    allBenches.slice(BENCHES_PER_STRIP, BENCHES_PER_STRIP * 2),
    allBenches.slice(BENCHES_PER_STRIP * 2, BENCHES_PER_STRIP * 3),
  ];

  // Layout math
  const stripGap = 18; // gap between strips
  const stripWidth = (usableWidth - stripGap * (STRIPS - 1)) / STRIPS;
  const cellWidth = stripWidth / SEATS_PER_BENCH;
  const cellHeight = 26;
  const tableTop = doc.y;

  for (let s = 0; s < STRIPS; s++) {
    const stripX = margin + s * (stripWidth + stripGap);
    const benches = stripBenches[s];

    for (let r = 0; r < BENCHES_PER_STRIP; r++) {
      const cellY = tableTop + r * cellHeight;
      const bench = benches[r]; // may be undefined if room not full

      const seats = bench
        ? [bench.left, bench.middle, bench.right]
        : [null, null, null];

      for (let c = 0; c < SEATS_PER_BENCH; c++) {
        const cellX = stripX + c * cellWidth;

        // Cell border
        doc
          .lineWidth(0.5)
          .rect(cellX, cellY, cellWidth, cellHeight)
          .stroke();

        // USN text (blank if seat is null/empty)
        const seat = seats[c];
        const usn = seat && seat.usn ? seat.usn : "";

        if (usn) {
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor("#000")
            .text(usn, cellX, cellY + cellHeight / 2 - 5, {
              width: cellWidth,
              align: "center",
              lineBreak: false,
            });
        }
      }
    }
  }

  // Move cursor past the table
  doc.y = tableTop + BENCHES_PER_STRIP * cellHeight + 10;
}

/**
 * Build notice board data from room allocation results.
 * Groups students by room and semester, computes USN ranges with
 * consecutive detection (ranges for consecutive, commas for non-consecutive).
 */
function buildNoticeData(rooms) {
  const result = [];

  for (const room of rooms) {
    // Group USNs by semester within this room
    const semMap = {};
    for (const bench of room.seating || []) {
      for (const pos of ["left", "middle", "right"]) {
        const s = bench[pos];
        if (!s || !s.usn || !s.semester) continue;
        const sem = s.semester;
        if (!semMap[sem]) semMap[sem] = [];
        semMap[sem].push(s.usn);
      }
    }

    const semesters = Object.keys(semMap).sort();
    if (semesters.length === 0) continue;

    const semRows = semesters.map((sem) => {
      const usns = semMap[sem].sort();
      const usnText = formatUSNRanges(usns);
      // Estimate row height based on text length
      const lines = Math.ceil(usnText.length / 40);
      const height = Math.max(24, lines * 14 + 10);
      return { semester: sem, usnText, count: usns.length, height };
    });

    result.push({ roomNo: room.roomNo, semesters: semRows });
  }

  return result;
}

/**
 * Format USN array into compact ranges.
 * Consecutive USNs (same prefix, sequential numbers) become ranges: 4VV23CI001-4VV23CI030
 * Non-consecutive are listed individually: 4VV23CI072, 074, 081
 */
function formatUSNRanges(usns) {
  if (usns.length === 0) return "—";
  if (usns.length === 1) return usns[0];

  // Group by prefix (everything except last 3 digits)
  const groups = {};
  for (const usn of usns) {
    const prefix = usn.slice(0, -3);
    const num = parseInt(usn.slice(-3), 10);
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(num);
  }

  // Build ranges per prefix, then join prefixes with newline
  const prefixLines = [];
  for (const prefix of Object.keys(groups).sort()) {
    const nums = groups[prefix].sort((a, b) => a - b);
    const rangeParts = [];

    // Find consecutive ranges
    let i = 0;
    while (i < nums.length) {
      const start = nums[i];
      let end = start;
      while (i + 1 < nums.length && nums[i + 1] === end + 1) {
        end = nums[++i];
      }

      const pad = (n) => String(n).padStart(3, "0");

      if (end - start >= 2) {
        rangeParts.push(`${prefix}${pad(start)}-${prefix}${pad(end)}`);
      } else if (end - start === 1) {
        rangeParts.push(`${prefix}${pad(start)}`);
        rangeParts.push(`${prefix}${pad(end)}`);
      } else {
        rangeParts.push(`${prefix}${pad(start)}`);
      }
      i++;
    }

    prefixLines.push(rangeParts.join(", "));
  }

  // Different branches on separate lines
  return prefixLines.join("\n");
}
/**
 * Map semester string to academic year number for sorting.
 * I,II → 1 | III,IV → 2 | V,VI → 3 | VII,VIII → 4
 */
function semesterToYear(sem) {
  const map = { I: 1, II: 1, III: 2, IV: 2, V: 3, VI: 3, VII: 4, VIII: 4 };
  return map[sem] || 99;
}

function semesterToOrder(sem) {
  const map = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
  return map[sem] || 99;
}

function yearLabel(year) {
  const labels = { 1: "1st Year", 2: "2nd Year", 3: "3rd Year", 4: "4th Year" };
  return labels[year] || `Year ${year}`;
}

module.exports = {
  writePDFHeader,
  writeCollegeHeader,
  renderClassroom,
  buildNoticeData,
  formatUSNRanges,
  semesterToYear,
  semesterToOrder,
  yearLabel,
};
