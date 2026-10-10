// Refactored module (pure move from server.js): PDF download routes

const express = require("express");
const PDFDocument = require("pdfkit");
const Allocation = require("../models/Allocation");
const Room = require("../models/Room");
const { isLoggedIn } = require("../middleware/auth");
const { writePDFHeader, writeCollegeHeader, renderClassroom, buildNoticeData } = require("../utils/pdf");
const router = express.Router();

// --- PDF: Absent Report ---
router.get("/api/pdf/absent-report/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    if (!alloc.attendance || alloc.attendance.length === 0) {
      return res.status(400).json({ error: "No attendance data saved for this exam." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Absent_Report_${(alloc.examName || "exam").replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`
    );

    const doc = new PDFDocument({ margin: 40, layout: "portrait" });

    doc.on("error", (err) => {
      console.error("PDF error:", err);
      if (!res.headersSent) res.status(500).json({ error: "PDF failed" });
      else res.end();
    });

    res.on("close", () => {
      if (!doc.writableEnded) doc.end();
    });

    doc.pipe(res);

    // Header
    writeCollegeHeader(doc);

    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const usableWidth = pageWidth - 2 * margin;

    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("Absent Students Report", margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(0.3);

    const semLabel = alloc.courses && alloc.courses.length > 0
      ? [...new Set(alloc.courses.map((c) => c.semester))].join(" & ") + " Semester"
      : "";
    doc
      .font("Helvetica")
      .fontSize(11)
      .text(`${alloc.examName || ""} ${semLabel} — ${alloc.date || ""} (${alloc.session || ""})`, margin, doc.y, {
        width: usableWidth,
        align: "center",
      });
    doc.moveDown(1);

    // Course-wise absent list
    const courses = alloc.courses || [];
    const attendance = alloc.attendance;

    // Build a USN lookup from attendanceByRoom for fallback (in case saved attendance is missing name/usn)
    const usnLookup = {};
    if (alloc.attendanceByRoom) {
      for (const room of alloc.attendanceByRoom) {
        for (const s of room.students) {
          if (s.usn) usnLookup[s.usn] = { name: s.name, semester: s.semester };
        }
      }
    }

    if (courses.length > 0) {
      for (const course of courses) {
        const sem = course.semester;
        const absentStudents = [];

        for (const room of attendance) {
          for (const s of room.students) {
            if (s.semester === sem && !s.present) {
              // Use fallback lookup if usn/name is missing
              const lookup = usnLookup[s.usn] || {};
              absentStudents.push({
                usn: s.usn || "",
                name: s.name || lookup.name || "",
                semester: s.semester,
                roomNo: room.roomNo,
              });
            }
          }
        }

        // Course header
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(`${course.courseName} (${course.courseCode}) — Sem ${sem}`, margin, doc.y);

        if (absentStudents.length === 0) {
          doc.font("Helvetica").fontSize(10).text("  All students present ✓");
          doc.moveDown(0.5);
          continue;
        }

        doc.font("Helvetica").fontSize(10).text(`  Absent: ${absentStudents.length} student(s)`);
        doc.moveDown(0.3);

        // Table
        const startX = margin + 10;
        let y = doc.y;
        const colW = [30, 110, 150, 70];

        doc.font("Helvetica-Bold").fontSize(9);
        doc.text("S.No", startX, y, { width: colW[0] });
        doc.text("USN", startX + colW[0], y, { width: colW[1] });
        doc.text("Name", startX + colW[0] + colW[1], y, { width: colW[2] });
        doc.text("Room", startX + colW[0] + colW[1] + colW[2], y, { width: colW[3] });
        y += 14;
        doc.moveTo(startX, y).lineTo(startX + 360, y).stroke();
        y += 4;

        doc.font("Helvetica").fontSize(9);
        absentStudents.forEach((s, idx) => {
          if (y > 720) {
            doc.addPage();
            y = 40;
          }
          doc.text(`${idx + 1}`, startX, y, { width: colW[0] });
          doc.text(s.usn || "—", startX + colW[0], y, { width: colW[1] });
          doc.text(s.name || "—", startX + colW[0] + colW[1], y, { width: colW[2] });
          doc.text(s.roomNo || "—", startX + colW[0] + colW[1] + colW[2], y, { width: colW[3] });
          y += 16;
        });

        doc.y = y + 10;
        doc.moveDown(0.5);
      }
    } else {
      // No courses — group by semester from attendance data
      const absentBySem = {};
      for (const room of attendance) {
        for (const s of room.students) {
          if (!s.present) {
            const sem = s.semester || "Unknown";
            if (!absentBySem[sem]) absentBySem[sem] = [];
            absentBySem[sem].push({ ...s, roomNo: room.roomNo });
          }
        }
      }

      for (const sem of Object.keys(absentBySem).sort()) {
        const students = absentBySem[sem];
        doc.font("Helvetica-Bold").fontSize(11).text(`Semester ${sem} — ${students.length} absent`);
        doc.moveDown(0.3);

        const startX = margin + 10;
        let y = doc.y;

        doc.font("Helvetica").fontSize(9);
        students.forEach((s, idx) => {
          if (y > 720) { doc.addPage(); y = 40; }
          doc.text(`${idx + 1}. ${s.usn} — ${s.name} (Room: ${s.roomNo})`, startX, y);
          y += 14;
        });

        doc.y = y + 10;
      }
    }

    doc.end();
  } catch (err) {
    console.error("Absent report PDF error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- PDF: Absent Report per Course ---
router.get("/api/pdf/absent-report/:id/course/:courseIdx", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) return res.status(404).json({ error: "Allocation not found" });
    if (!alloc.attendance || alloc.attendance.length === 0)
      return res.status(400).json({ error: "No attendance data saved." });

    const courseIdx = parseInt(req.params.courseIdx, 10);
    const courses = alloc.courses || [];
    if (courseIdx < 0 || courseIdx >= courses.length)
      return res.status(400).json({ error: "Invalid course index." });

    const course = courses[courseIdx];
    const sem = course.semester;

    // Build USN lookup fallback
    const usnLookup = {};
    if (alloc.attendanceByRoom) {
      for (const room of alloc.attendanceByRoom) {
        for (const s of room.students) {
          if (s.usn) usnLookup[s.usn] = { name: s.name, semester: s.semester };
        }
      }
    }

    // Collect absent students for this course
    const absentStudents = [];
    for (const room of alloc.attendance) {
      for (const s of room.students) {
        if (s.semester === sem && !s.present) {
          const lookup = usnLookup[s.usn] || {};
          absentStudents.push({
            usn: s.usn || "",
            name: s.name || lookup.name || "",
            roomNo: room.roomNo,
          });
        }
      }
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition",
      `inline; filename="Absent_Report_${course.courseName.replace(/[^a-zA-Z0-9]/g, '_')}_Sem${sem}.pdf"`);

    const doc = new PDFDocument({ margin: 40, layout: "portrait" });
    doc.on("error", (err) => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    res.on("close", () => { if (!doc.writableEnded) doc.end(); });
    doc.pipe(res);

    writeCollegeHeader(doc);
    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const usableWidth = pageWidth - 2 * margin;

    doc.font("Helvetica-Bold").fontSize(14)
      .text("Absent Students Report", margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(12)
      .text(`${course.courseName} (${course.courseCode}) — Sem ${sem}`, margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10)
      .text(`${alloc.examName || ""} — ${alloc.date || ""} (${alloc.session || ""})`, margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(1);

    if (absentStudents.length === 0) {
      doc.font("Helvetica").fontSize(12).text("All students present ✓", { align: "center" });
      doc.end();
      return;
    }

    doc.font("Helvetica-Bold").fontSize(11).text(`Absent: ${absentStudents.length} student(s)`);
    doc.moveDown(0.4);

    // Table
    const startX = margin + 10;
    let y = doc.y;
    const colW = [35, 120, 180, 80];

    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("S.No", startX, y, { width: colW[0] });
    doc.text("USN", startX + colW[0], y, { width: colW[1] });
    doc.text("Name", startX + colW[0] + colW[1], y, { width: colW[2] });
    doc.text("Room", startX + colW[0] + colW[1] + colW[2], y, { width: colW[3] });
    y += 14;
    doc.moveTo(startX, y).lineTo(startX + 415, y).stroke();
    y += 4;

    doc.font("Helvetica").fontSize(9);
    absentStudents.forEach((s, idx) => {
      if (y > 720) { doc.addPage(); y = 40; }
      doc.text(`${idx + 1}`, startX, y, { width: colW[0] });
      doc.text(s.usn || "—", startX + colW[0], y, { width: colW[1] });
      doc.text(s.name || "—", startX + colW[0] + colW[1], y, { width: colW[2] });
      doc.text(s.roomNo || "—", startX + colW[0] + colW[1] + colW[2], y, { width: colW[3] });
      y += 16;
    });

    doc.end();
  } catch (err) {
    console.error("Course absent report error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- PDF: Absent Report per Room ---
router.get("/api/pdf/absent-report/:id/room/:roomNo", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) return res.status(404).json({ error: "Allocation not found" });
    if (!alloc.attendance || alloc.attendance.length === 0)
      return res.status(400).json({ error: "No attendance data saved." });

    const roomNo = req.params.roomNo;
    const roomAtt = alloc.attendance.find((a) => a.roomNo === roomNo);
    if (!roomAtt) return res.status(404).json({ error: `No attendance for room ${roomNo}.` });

    // Build USN lookup fallback
    const usnLookup = {};
    if (alloc.attendanceByRoom) {
      for (const room of alloc.attendanceByRoom) {
        for (const s of room.students) {
          if (s.usn) usnLookup[s.usn] = { name: s.name, semester: s.semester };
        }
      }
    }

    const absentStudents = roomAtt.students
      .filter((s) => !s.present)
      .map((s) => {
        const lookup = usnLookup[s.usn] || {};
        return { usn: s.usn || "", name: s.name || lookup.name || "", semester: s.semester || "" };
      });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition",
      `inline; filename="Absent_Report_Room_${roomNo}.pdf"`);

    const doc = new PDFDocument({ margin: 40, layout: "portrait" });
    doc.on("error", (err) => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    res.on("close", () => { if (!doc.writableEnded) doc.end(); });
    doc.pipe(res);

    writeCollegeHeader(doc);
    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const usableWidth = pageWidth - 2 * margin;

    doc.font("Helvetica-Bold").fontSize(14)
      .text("Absent Students Report", margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(12)
      .text(`Room: ${roomNo}`, margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10)
      .text(`${alloc.examName || ""} — ${alloc.date || ""} (${alloc.session || ""})`, margin, doc.y, { width: usableWidth, align: "center" });
    doc.moveDown(1);

    if (absentStudents.length === 0) {
      doc.font("Helvetica").fontSize(12).text("All students present ✓", { align: "center" });
      doc.end();
      return;
    }

    doc.font("Helvetica-Bold").fontSize(11).text(`Absent: ${absentStudents.length} student(s)`);
    doc.moveDown(0.4);

    // Table
    const startX = margin + 10;
    let y = doc.y;
    const colW = [35, 120, 200, 60];

    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("S.No", startX, y, { width: colW[0] });
    doc.text("USN", startX + colW[0], y, { width: colW[1] });
    doc.text("Name", startX + colW[0] + colW[1], y, { width: colW[2] });
    doc.text("Sem", startX + colW[0] + colW[1] + colW[2], y, { width: colW[3] });
    y += 14;
    doc.moveTo(startX, y).lineTo(startX + 415, y).stroke();
    y += 4;

    doc.font("Helvetica").fontSize(9);
    absentStudents.forEach((s, idx) => {
      if (y > 720) { doc.addPage(); y = 40; }
      doc.text(`${idx + 1}`, startX, y, { width: colW[0] });
      doc.text(s.usn || "—", startX + colW[0], y, { width: colW[1] });
      doc.text(s.name || "—", startX + colW[0] + colW[1], y, { width: colW[2] });
      doc.text(s.semester || "—", startX + colW[0] + colW[1] + colW[2], y, { width: colW[3] });
      y += 16;
    });

    doc.end();
  } catch (err) {
    console.error("Room absent report error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ============================================================
// PDF GENERATION ROUTES
// ============================================================

// --- PDF: Notice Board Sheet ---
router.get("/api/pdf/notice/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="notice_${alloc.examName || "exam"}.pdf"`
    );

    const doc = new PDFDocument({ margin: 40, layout: "portrait" });

    doc.on("error", (err) => {
      console.error("PDF generation error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed" });
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      if (!doc.writableEnded) {
        doc.end();
      }
    });

    doc.pipe(res);

    // ── College Header ──────────────────────────────────────
    writeCollegeHeader(doc);

    // ── Department title ────────────────────────────────────
    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const usableWidth = pageWidth - 2 * margin;

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("Department of CSE (Artificial Intelligence & Machine Learning)", margin, doc.y, {
        width: usableWidth,
        align: "center",
      });
    doc.moveDown(0.3);

    // ── "Seating Arrangement for II & IV Semester CCE-II" ───
    const semLabel = alloc.courses && alloc.courses.length > 0
      ? [...new Set(alloc.courses.map((c) => c.semester))].join(" & ") + " Semester"
      : "";
    const titleLine = `Seating Arrangement for ${semLabel} ${alloc.examName || ""}`.trim();
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(titleLine, margin, doc.y, {
        width: usableWidth,
        align: "center",
      });
    doc.moveDown(0.8);

    // ── Date line: "Date: DD-MM-YYYY (Morning Session)" ─────
    const dateFormatted = alloc.date
      ? alloc.date.split("-").reverse().join("-") // YYYY-MM-DD → DD-MM-YYYY
      : "—";
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`Date: ${dateFormatted} (${alloc.session || "—"} Session)`, margin, doc.y, {
        width: usableWidth,
        align: "left",
      });
    doc.moveDown(0.8);

    // ── Build notice board data from allocation rooms ────────
    // For each room, group students by semester and compute USN ranges
    const noticeData = buildNoticeData(alloc.rooms || []);

    if (noticeData.length === 0) {
      doc.fontSize(12).text("No allocation data available.", { align: "center" });
      doc.end();
      return;
    }

    // ── Draw table ──────────────────────────────────────────
    const colWidths = [70, 50, 260, 80]; // Room No, Sem, Roll No, Total
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const tableX = margin + (usableWidth - tableWidth) / 2; // Center table
    let y = doc.y;

    // Table header
    const headerHeight = 36;
    doc.lineWidth(1);
    doc.rect(tableX, y, tableWidth, headerHeight).stroke();

    // Header cells
    const headers = ["Room No", "Sem/\nSec", "Roll No", "Total No.\nof\nStudents"];
    let cellX = tableX;
    doc.font("Helvetica-Bold").fontSize(10);
    for (let i = 0; i < headers.length; i++) {
      doc.rect(cellX, y, colWidths[i], headerHeight).stroke();
      doc.text(headers[i], cellX + 4, y + 6, {
        width: colWidths[i] - 8,
        align: "center",
        lineBreak: true,
      });
      cellX += colWidths[i];
    }
    y += headerHeight;

    // Data rows
    doc.font("Helvetica").fontSize(9);

    for (const room of noticeData) {
      const semRows = room.semesters;
      const roomRowHeight = semRows.reduce((sum, sr) => sum + sr.height, 0);

      // Check page overflow
      if (y + roomRowHeight > doc.page.height - 60) {
        doc.addPage({ layout: "portrait" });
        y = 40;
      }

      // Room No cell (merged vertically)
      doc.rect(tableX, y, colWidths[0], roomRowHeight).stroke();
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(room.roomNo, tableX + 4, y + roomRowHeight / 2 - 6, {
          width: colWidths[0] - 8,
          align: "center",
        });

      // Each semester row within this room
      let semY = y;
      for (const sr of semRows) {
        // Sem cell
        doc.rect(tableX + colWidths[0], semY, colWidths[1], sr.height).stroke();
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(sr.semester, tableX + colWidths[0] + 4, semY + sr.height / 2 - 5, {
            width: colWidths[1] - 8,
            align: "center",
          });

        // Roll No cell
        doc.rect(tableX + colWidths[0] + colWidths[1], semY, colWidths[2], sr.height).stroke();
        doc
          .font("Helvetica")
          .fontSize(9)
          .text(sr.usnText, tableX + colWidths[0] + colWidths[1] + 6, semY + 6, {
            width: colWidths[2] - 12,
            align: "center",
          });

        // Total cell
        doc.rect(tableX + colWidths[0] + colWidths[1] + colWidths[2], semY, colWidths[3], sr.height).stroke();
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(
            String(sr.count),
            tableX + colWidths[0] + colWidths[1] + colWidths[2] + 4,
            semY + sr.height / 2 - 5,
            { width: colWidths[3] - 8, align: "center" }
          );

        semY += sr.height;
      }

      y += roomRowHeight;
    }

    doc.end();
  } catch (err) {
    console.error("Notice PDF error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// --- PDF: Detailed Seating Layout (Classroom Template) ---
router.get("/api/pdf/seating/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="seating_${alloc.examName || "exam"}.pdf"`
    );

    const doc = new PDFDocument({ margin: 40, layout: "landscape" });

    doc.on("error", (err) => {
      console.error("PDF generation error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed" });
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      if (!doc.writableEnded) {
        doc.end();
      }
    });

    doc.pipe(res);

    if (!alloc.rooms || alloc.rooms.length === 0) {
      doc.fontSize(12).text("No seating data available.", { align: "center" });
      doc.end();
      return;
    }

    // One page per classroom
    for (let roomIdx = 0; roomIdx < alloc.rooms.length; roomIdx++) {
      const room = alloc.rooms[roomIdx];

      if (roomIdx > 0) {
        doc.addPage({ layout: "landscape" });
      }

      // ── College Header ──────────────────────────────────────
      writeCollegeHeader(doc);

      // Build semester label from courses (e.g. "II & IV Semester")
      const semLabel = alloc.courses && alloc.courses.length > 0
        ? [...new Set(alloc.courses.map((c) => c.semester))].join(" & ") + " Semester"
        : "";

      // ── Render classroom grid ───────────────────────────────
      renderClassroom(doc, room, alloc.examName, semLabel);
    }

    doc.end();
  } catch (err) {
    console.error("Seating PDF error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// --- PDF: Attendance Sheet ---
router.get("/api/pdf/attendance/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="attendance_${alloc.examName || "exam"}.pdf"`
    );

    const doc = new PDFDocument({ margin: 50 });

    doc.on("error", (err) => {
      console.error("PDF generation error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed" });
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      if (!doc.writableEnded) {
        doc.end();
      }
    });

    doc.pipe(res);

    writePDFHeader(
      doc,
      "Attendance Sheet",
      alloc.examName || "Unknown Exam",
      alloc.date || "—",
      alloc.session || "—"
    );

    if (!alloc.attendanceByRoom || alloc.attendanceByRoom.length === 0) {
      doc.fontSize(12).text("No attendance data available.", { align: "center" });
      doc.end();
      return;
    }

    for (let roomIdx = 0; roomIdx < alloc.attendanceByRoom.length; roomIdx++) {
      const room = alloc.attendanceByRoom[roomIdx];

      // Start each room on a new page (except the first)
      if (roomIdx > 0) {
        doc.addPage();
      }

      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(`Room: ${room.roomNo || "—"} – Attendance`, { underline: true });
      doc.moveDown(0.5);

      // Table header setup
      const pageMargin = 50;
      const startX = pageMargin;
      let y = doc.y + 5;

      const drawAttendanceHeader = () => {
        doc.font("Helvetica-Bold").fontSize(10);
        doc.text("S.No", startX, y, { width: 40 });
        doc.text("USN", startX + 40, y, { width: 120 });
        doc.text("Name", startX + 160, y, { width: 180 });
        doc.text("Batch", startX + 340, y, { width: 40 });
        doc.text("Signature", startX + 380, y, { width: 120 });
        y += 18;
        doc.moveTo(startX, y).lineTo(startX + 500, y).stroke();
        y += 4;
        doc.font("Helvetica").fontSize(9);
      };

      drawAttendanceHeader();

      if (room.students && room.students.length > 0) {
        room.students.forEach((student, idx) => {
          // Check if we need a new page BEFORE writing the row
          if (y + 20 > 720) {
            doc.addPage();
            y = 50;
            drawAttendanceHeader();
          }

          doc.text(`${idx + 1}`, startX, y, { width: 40 });
          doc.text(student.usn || "—", startX + 40, y, { width: 120 });
          doc.text(student.name || "—", startX + 160, y, { width: 180 });
          doc.text(student.semester || "—", startX + 340, y, { width: 40 });
          // Signature box placeholder
          doc.rect(startX + 380, y - 2, 110, 16).stroke();
          y += 20;
        });
      } else {
        doc.text("No students", startX, y);
      }
    }

    doc.end();
  } catch (err) {
    console.error("Attendance PDF error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;
