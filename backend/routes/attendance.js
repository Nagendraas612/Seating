// Refactored module (pure move from server.js): attendance routes

const express = require("express");
const PDFDocument = require("pdfkit");
const Allocation = require("../models/Allocation");
const Room = require("../models/Room");
const { isLoggedIn } = require("../middleware/auth");
const { writeCollegeHeader, semesterToYear, semesterToOrder, yearLabel } = require("../utils/pdf");
const router = express.Router();

// ============================================================
// ATTENDANCE SAVE ROUTE
// ============================================================

// POST save attendance for a specific room in an allocation
router.post("/api/attendance/save", isLoggedIn, async (req, res) => {
  try {
    const { allocationId, roomNo, students, status } = req.body;

    if (!allocationId || !roomNo || !students) {
      return res.status(400).json({ error: "allocationId, roomNo, and students are required." });
    }

    const validStatus = ["draft", "saved", "finalized"].includes(status) ? status : "draft";

    const allocation = await Allocation.findById(allocationId);
    if (!allocation) {
      return res.status(404).json({ error: "Allocation not found." });
    }

    // Find or create attendance entry for this room
    if (!allocation.attendance) allocation.attendance = [];

    const existingIdx = allocation.attendance.findIndex((a) => a.roomNo === roomNo);

    // Block changes to finalized attendance
    if (existingIdx >= 0 && allocation.attendance[existingIdx].status === "finalized") {
      return res.status(403).json({ error: "This room's attendance has been finalized and cannot be changed." });
    }

    const attendanceEntry = {
      roomNo,
      status: validStatus,
      savedAt: new Date(),
      students: students.map((s) => ({
        usn: s.usn || "",
        name: s.name || "",
        semester: s.semester || "",
        present: s.present !== false,
      })),
    };

    if (existingIdx >= 0) {
      allocation.attendance[existingIdx] = attendanceEntry;
    } else {
      allocation.attendance.push(attendanceEntry);
    }

    await allocation.save();

    const messages = {
      draft: "Attendance saved as draft.",
      saved: "Attendance saved successfully.",
      finalized: "Attendance finalized. No further changes allowed.",
    };
    res.json({ message: messages[validStatus], status: validStatus });
  } catch (err) {
    console.error("Save attendance error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ATTENDANCE — ABSENT STUDENTS PDF
// POST /api/attendance/absent-pdf
// Body: { examName, date, session, roomNo, courses, absentStudents }
// absentStudents: [{ name, usn, semester }]
// ============================================================

router.post("/api/attendance/absent-pdf", isLoggedIn, async (req, res) => {
  try {
    const { examName, date, session, roomNo, courses, absentStudents } = req.body;

    if (!absentStudents || absentStudents.length === 0) {
      return res.status(400).json({ error: "No absent students provided." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="absent_${examName || "exam"}_Room${roomNo || ""}.pdf"`
    );

    const doc = new PDFDocument({ margin: 50 });

    doc.on("error", (err) => {
      console.error("Absent PDF error:", err);
      if (!res.headersSent) res.status(500).json({ error: "PDF generation failed" });
      else res.end();
    });

    res.on("close", () => {
      if (!doc.writableEnded) doc.end();
    });

    doc.pipe(res);

    // ── College Header ──────────────────────────────────────
    writeCollegeHeader(doc);

    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const usableWidth = pageWidth - 2 * margin;

    // ── Title ───────────────────────────────────────────────
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("Absent Students Report", margin, doc.y, {
        width: usableWidth,
        align: "center",
      });
    doc.moveDown(0.3);

    // ── Exam info line ──────────────────────────────────────
    const dateFormatted = date
      ? date.split("-").reverse().join("-")
      : "—";
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(
        `Exam: ${examName || "—"}   |   Date: ${dateFormatted}   |   Session: ${session || "—"}   |   Room: ${roomNo || "—"}`,
        margin,
        doc.y,
        { width: usableWidth, align: "center" }
      );
    doc.moveDown(0.4);

    // ── Course info ─────────────────────────────────────────
    if (courses && courses.length > 0) {
      const courseText = courses
        .map((c) => `${c.courseName || ""}${c.courseCode ? " (" + c.courseCode + ")" : ""} — Sem ${c.semester || "—"}`)
        .join("   |   ");
      doc
        .font("Helvetica-Oblique")
        .fontSize(9)
        .text(courseText, margin, doc.y, { width: usableWidth, align: "center" });
      doc.moveDown(0.4);
    }

    // ── Divider ─────────────────────────────────────────────
    doc
      .moveTo(margin, doc.y)
      .lineTo(pageWidth - margin, doc.y)
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.5);

    // ── Group absent students by academic year ──────────────
    const yearGroups = {};
    for (const s of absentStudents) {
      const yr = semesterToYear(s.semester);
      if (!yearGroups[yr]) yearGroups[yr] = [];
      yearGroups[yr].push(s);
    }

    // Sort each group by semester then USN
    for (const yr of Object.keys(yearGroups)) {
      yearGroups[yr].sort((a, b) => {
        const semDiff = semesterToOrder(a.semester) - semesterToOrder(b.semester);
        if (semDiff !== 0) return semDiff;
        return a.usn.localeCompare(b.usn);
      });
    }

    const sortedYears = Object.keys(yearGroups).map(Number).sort();

    // ── Table column widths ─────────────────────────────────
    const colW = [35, 130, 200, 60]; // S.No, USN, Name, Sem
    const tableWidth = colW.reduce((a, b) => a + b, 0);
    const tableX = margin;
    const rowH = 22;
    const headerH = 24;

    let globalIdx = 1;

    for (const yr of sortedYears) {
      const students = yearGroups[yr];

      // ── Year section heading ────────────────────────────
      if (doc.y + 60 > doc.page.height - 60) {
        doc.addPage();
      }

      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#1a1a2e")
        .text(`${yearLabel(yr)} — Absent Students (${students.length})`, margin, doc.y);
      doc.moveDown(0.3);

      // ── Table header ────────────────────────────────────
      let y = doc.y;
      const headers = ["S.No", "USN", "Name", "Sem"];
      doc.lineWidth(0.8);
      doc.rect(tableX, y, tableWidth, headerH).fillAndStroke("#1a1a2e", "#1a1a2e");

      let cx = tableX;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff");
      for (let i = 0; i < headers.length; i++) {
        doc.text(headers[i], cx + 4, y + 7, {
          width: colW[i] - 8,
          align: i === 2 ? "left" : "center",
          lineBreak: false,
        });
        cx += colW[i];
      }
      y += headerH;
      doc.fillColor("#000000");

      // ── Table rows ──────────────────────────────────────
      for (const s of students) {
        if (y + rowH > doc.page.height - 60) {
          doc.addPage();
          y = 50;

          // Repeat header on new page
          doc.rect(tableX, y, tableWidth, headerH).fillAndStroke("#1a1a2e", "#1a1a2e");
          cx = tableX;
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff");
          for (let i = 0; i < headers.length; i++) {
            doc.text(headers[i], cx + 4, y + 7, {
              width: colW[i] - 8,
              align: i === 2 ? "left" : "center",
              lineBreak: false,
            });
            cx += colW[i];
          }
          y += headerH;
          doc.fillColor("#000000");
        }

        // Alternating row background
        const isEven = globalIdx % 2 === 0;
        if (isEven) {
          doc.rect(tableX, y, tableWidth, rowH).fill("#fef2f2").stroke();
        } else {
          doc.rect(tableX, y, tableWidth, rowH).stroke();
        }

        doc.font("Helvetica").fontSize(9).fillColor("#000000");
        const cells = [
          { text: String(globalIdx), align: "center" },
          { text: s.usn || "—", align: "center" },
          { text: s.name || "—", align: "left" },
          { text: s.semester || "—", align: "center" },
        ];

        cx = tableX;
        for (let i = 0; i < cells.length; i++) {
          doc.text(cells[i].text, cx + 4, y + 6, {
            width: colW[i] - 8,
            align: cells[i].align,
            lineBreak: false,
          });
          cx += colW[i];
        }

        y += rowH;
        globalIdx++;
      }

      doc.y = y + 12;
    }

    // ── Summary footer ──────────────────────────────────────
    doc.moveDown(0.5);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#000")
      .text(`Total Absent: ${absentStudents.length}`, margin, doc.y);

    doc.end();
  } catch (err) {
    console.error("Absent PDF generation error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;
