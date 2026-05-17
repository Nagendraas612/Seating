// ============================================================
// AIML Internal Examination Seat Allotment System - Backend
// ============================================================
// server.js - Main entry point for the backend server
// Handles: Google OAuth, File Upload, Seating Algorithm, PDFs, MongoDB
// ============================================================

require("dotenv").config(); // Load .env variables (MONGO_URI, GOOGLE_CLIENT_ID, etc.)

const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require("multer");
const xlsx = require("xlsx");
const PDFDocument = require("pdfkit");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================================
// MIDDLEWARE SETUP
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Allow frontend (on different port or domain) to call backend
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true, // Required for session cookies
  })
);

// Serve static frontend files (for production on Render)
app.use(express.static(path.join(__dirname, "../frontend")));

// ============================================================
// MONGODB CONNECTION
// ============================================================

mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/aiml_seats")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// ============================================================
// MONGODB SCHEMAS & MODELS
// ============================================================

// --- Room Schema ---
// Stores room details like room number, bench count, enabled status
const roomSchema = new mongoose.Schema({
  roomNo: { type: String, required: true, unique: true },
  benches: { type: Number, required: true },
  enabled: { type: Boolean, default: true },
});
const Room = mongoose.model("Room", roomSchema);

// --- Allocation History Schema ---
// Stores each exam's seating allocation for history/reuse
const allocationSchema = new mongoose.Schema({
  examName: String,
  date: String,
  session: String, // Morning / Afternoon
  createdAt: { type: Date, default: Date.now },
  rooms: [
    {
      roomNo: String,
      benches: Number,
      seating: [
        {
          bench: Number,
          left: { name: String, usn: String, semester: String },
          middle: { name: String, usn: String, semester: String },
          right: { name: String, usn: String, semester: String },
        },
      ],
    },
  ],
  // Summary: notice board view
  summary: [
    {
      roomNo: String,
      semesters: [String],
      usnRanges: [String],
      studentCount: Number,
    },
  ],
  // Flat list for attendance sheets
  attendanceByRoom: [
    {
      roomNo: String,
      students: [{ name: String, usn: String, semester: String }],
    },
  ],
});
const Allocation = mongoose.model("Allocation", allocationSchema);

// ============================================================
// SESSION SETUP (uses MongoDB to persist sessions)
// ============================================================

app.use(
  session({
    secret: process.env.SESSION_SECRET || "aiml_secret_key_change_in_prod",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI || "mongodb://localhost:27017/aiml_seats",
    }),
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// ============================================================
// GOOGLE OAUTH SETUP
// ============================================================

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      // Here you can restrict to specific email domains if needed
      // e.g. if (!profile.emails[0].value.endsWith('@college.edu')) return done(null, false);
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ============================================================
// AUTH MIDDLEWARE
// Protect routes - only logged-in users can access
// ============================================================

function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Unauthorized. Please login with Google." });
}

// ============================================================
// AUTH ROUTES
// ============================================================

// Start Google login
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// Google redirects here after login
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    // Redirect to frontend dashboard after successful login
    res.redirect(process.env.FRONTEND_URL || "http://localhost:3000");
  }
);

// Logout
app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    res.json({ message: "Logged out successfully" });
  });
});

// Check login status (frontend calls this on load)
app.get("/auth/status", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      loggedIn: true,
      user: {
        name: req.user.displayName,
        email: req.user.emails[0].value,
        photo: req.user.photos[0]?.value,
      },
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============================================================
// FILE UPLOAD SETUP (multer - stores in memory for processing)
// ============================================================

const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// ROOM MANAGEMENT ROUTES
// ============================================================

// GET all rooms
app.get("/api/rooms", isLoggedIn, async (req, res) => {
  try {
    const rooms = await Room.find().sort({ roomNo: 1 });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a new room
app.post("/api/rooms", isLoggedIn, async (req, res) => {
  try {
    const { roomNo, benches, enabled } = req.body;
    const room = new Room({ roomNo, benches: Number(benches), enabled });
    await room.save();
    res.json({ message: "Room added", room });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update a room
app.put("/api/rooms/:id", isLoggedIn, async (req, res) => {
  try {
    const { roomNo, benches, enabled } = req.body;
    const room = await Room.findByIdAndUpdate(
      req.params.id,
      { roomNo, benches: Number(benches), enabled },
      { new: true }
    );
    res.json({ message: "Room updated", room });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE a room
app.delete("/api/rooms/:id", isLoggedIn, async (req, res) => {
  try {
    await Room.findByIdAndDelete(req.params.id);
    res.json({ message: "Room deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SEATING ALGORITHM
// ============================================================

/**
 * SEATING RULES:
 * 1. Students stay in USN order — no shuffling.
 * 2. Each bench: Left | Middle | Right (3 seats).
 * 3. Anti-copy: Middle must differ from Left and Right.
 *    Allowed:  A B A  or  B A B
 * 4. Row alternation within a room (3 rows, N benches each):
 *      Room starts ABA:  Row1=ABA, Row2=BAB, Row3=ABA
 *      Room starts BAB:  Row1=BAB, Row2=ABA, Row3=BAB
 * 5. Room alternation:
 *      Room-1 starts ABA, Room-2 starts BAB, Room-3 starts ABA ...
 *
 * THE KEY FIX — GLOBAL A/B IDENTITY:
 *
 *   A and B are decided ONCE at the very start and NEVER change.
 *   If IV is A, it stays A across Room-1, Room-2, Room-3, etc.
 *
 *   WHY previous versions broke:
 *     Old code called getTopTwoBatches() per room.
 *     After Room-1 consumed more IV than VI, VI became the new
 *     "dominant" batch, so VI was labelled A for Room-2.
 *     Room-2 BAB with A=VI: [B,A,B] = [IV,VI,IV]
 *     That looks identical to Room-1 ABA with A=IV: [A,B,A] = [IV,VI,IV]
 *     Result: both rooms looked the same.
 *
 *   With GLOBAL identity:
 *     A=IV always. Room-2 BAB: [B,A,B] = [VI,IV,VI]
 *     Rooms now look visually different from each other.
 *
 * 6. Exhaustion: if a slot's batch runs out, that seat is empty (null).
 *    No undefined values are ever stored.
 */

function allocateSeats(semesterStudents, rooms) {

  // =========================================================
  // STEP 1 — BUILD QUEUES sorted by USN
  // =========================================================

  const batches = {};
  for (const sem in semesterStudents) {
    batches[sem] = [...semesterStudents[sem]].sort((a, b) =>
      a.usn.localeCompare(b.usn)
    );
  }

  const semKeys = Object.keys(batches);
  const queues = {};
  for (const sem of semKeys) queues[sem] = 0;

  // =========================================================
  // STEP 2 — HELPERS
  // =========================================================

  function remaining(sem) {
    return batches[sem].length - queues[sem];
  }

  function hasStudentsLeft() {
    return semKeys.some((sem) => remaining(sem) > 0);
  }

  // Pop next student from a semester queue. Returns null if exhausted.
  function getNextStudent(sem) {
    if (!sem || queues[sem] >= batches[sem].length) return null;
    const student = batches[sem][queues[sem]++];
    return { ...student, semester: sem };
  }

  // Return [first, second] semesters sorted by remaining count.
  function getTopTwoBatches() {
    const avail = semKeys
      .map((sem) => ({ sem, count: remaining(sem) }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    if (avail.length === 0) return [null, null];
    if (avail.length === 1) return [avail[0].sem, null];
    return [avail[0].sem, avail[1].sem];
  }

  // =========================================================
  // STEP 3 — LOCK GLOBAL A/B IDENTITY (called exactly ONCE)
  //
  // globalSemA = whichever semester starts with more students.
  // globalSemB = the other semester.
  // These NEVER change between rooms. This is the core fix.
  // =========================================================

  const [globalSemA, globalSemB] = getTopTwoBatches();

  // =========================================================
  // STEP 4 — ROOM-BY-ROOM ALLOCATION
  // =========================================================

  const ROWS_PER_ROOM = 3;
  const finalRooms = [];

  for (let roomIdx = 0; roomIdx < rooms.length; roomIdx++) {

    if (!hasStudentsLeft()) break;

    const room = rooms[roomIdx];
    const roomResult = {
      roomNo: room.roomNo,
      benches: room.benches,
      seating: [],
    };

    // Room-0,2,4... start ABA. Room-1,3,5... start BAB.
    // This ONLY determines the starting row pattern.
    // globalSemA and globalSemB are never touched here.
    const roomStartsWithABA = roomIdx % 2 === 0;

    // Divide room benches evenly across 3 rows
    const benchesPerRow = Math.ceil(room.benches / ROWS_PER_ROOM);

    for (let row = 0; row < ROWS_PER_ROOM; row++) {

      if (!hasStudentsLeft()) break;

      // Determine this row's pattern:
      //   roomStartsWithABA=true  -> row0=ABA, row1=BAB, row2=ABA
      //   roomStartsWithABA=false -> row0=BAB, row1=ABA, row2=BAB
      const rowIsABA = roomStartsWithABA
        ? row % 2 === 0
        : row % 2 !== 0;

      for (let b = 0; b < benchesPerRow; b++) {

        const benchNum = row * benchesPerRow + b + 1;
        if (benchNum > room.benches) break;
        if (!hasStudentsLeft()) break;

        // SLOT ASSIGNMENT using the locked global A/B identity:
        //   ABA -> [globalSemA, globalSemB, globalSemA]  e.g. IV VI IV
        //   BAB -> [globalSemB, globalSemA, globalSemB]  e.g. VI IV VI
        //
        // If a slot's batch is exhausted, that slot becomes null (empty seat).
        const desired = rowIsABA
          ? [globalSemA, globalSemB, globalSemA]
          : [globalSemB, globalSemA, globalSemB];

        const slots = desired.map((sem) =>
          sem && remaining(sem) > 0 ? sem : null
        );

        const benchData = {
          row:    row + 1,    // 1-indexed row number (used for PDF row headers)
          bench:  benchNum,
          left:   getNextStudent(slots[0]),
          middle: getNextStudent(slots[1]),
          right:  getNextStudent(slots[2]),
        };

        // Only push if at least one seat is filled
        if (benchData.left || benchData.middle || benchData.right) {
          roomResult.seating.push(benchData);
        }
      }
    }

    finalRooms.push(roomResult);
  }

  return finalRooms;
}


// ============================================================
// BUILD SUMMARY (Notice Board) and ATTENDANCE from results
// ============================================================

function buildSummary(roomResults) {
  return roomResults.map((room) => {
    const semMap = {}; // { semCode: [usns] }
    for (const bench of room.seating) {
      for (const pos of ["left", "middle", "right"]) {
        const s = bench[pos];
        if (s) {
          if (!semMap[s.semester]) semMap[s.semester] = [];
          semMap[s.semester].push(s.usn);
        }
      }
    }

    const semesters = Object.keys(semMap);
    const usnRanges = semesters.map((sem) => {
      const usns = semMap[sem].sort();
      return `${sem}: ${usns[0]} – ${usns[usns.length - 1]}`;
    });
    const studentCount = semesters.reduce(
      (sum, s) => sum + semMap[s].length,
      0
    );

    return { roomNo: room.roomNo, semesters, usnRanges, studentCount };
  });
}

function buildAttendance(roomResults) {
  return roomResults.map((room) => {
    const students = [];
    for (const bench of room.seating) {
      for (const pos of ["left", "middle", "right"]) {
        if (bench[pos]) students.push(bench[pos]);
      }
    }
    // Sort by USN for attendance sheet
    students.sort((a, b) => a.usn.localeCompare(b.usn));
    return { roomNo: room.roomNo, students };
  });
}

// ============================================================
// MAIN ALLOCATION ROUTE
// POST /api/allocate
// Accepts: exam details + multiple Excel/CSV files (one per semester)
// ============================================================

app.post(
  "/api/allocate",
  isLoggedIn,
  upload.array("semesterFiles"), // field name "semesterFiles", multiple files
  async (req, res) => {
    try {
      const { examName, date, session } = req.body;

      if (!examName || !date || !session) {
        return res
          .status(400)
          .json({ error: "examName, date, and session are required." });
      }

      // --- Parse uploaded Excel/CSV files ---
      // Each file's original name should contain the semester code
      // e.g. "II_sem.xlsx", "IV_sem.xlsx"
      const semesterStudents = {}; // { "II": [{name, usn},...], ... }

      for (const file of req.files) {
        // Try to extract semester from filename (e.g. "II_sem.xlsx" → "II")
        const nameParts = file.originalname.replace(/\.[^/.]+$/, "").split("_");
        const semCode = nameParts[0].toUpperCase(); // e.g. "II"

        // Parse using xlsx library
        const workbook = xlsx.read(file.buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = xlsx.utils.sheet_to_json(sheet);

        // Expected columns: Name, USN (case-insensitive)
        const students = rows
          .map((row) => {
            const name =
              row["Name"] || row["name"] || row["NAME"] || "";
            const usn =
              row["USN"] || row["usn"] || row["Usn"] || "";
            return { name: name.trim(), usn: usn.trim() };
          })
          .filter((s) => s.name && s.usn); // Remove empty rows

        semesterStudents[semCode] = students;
      }

      if (Object.keys(semesterStudents).length === 0) {
        return res
          .status(400)
          .json({ error: "No valid student files uploaded." });
      }

      // --- Fetch enabled rooms from DB, sorted ---
      const rooms = await Room.find({ enabled: true }).sort({ roomNo: 1 });
      if (rooms.length === 0) {
        return res
          .status(400)
          .json({ error: "No enabled rooms found. Please add rooms first." });
      }

      // --- Run seating algorithm ---
      const roomResults = allocateSeats(semesterStudents, rooms);

      // --- Build summary and attendance ---
      const summary = buildSummary(roomResults);
      const attendanceByRoom = buildAttendance(roomResults);

      // --- Save to MongoDB ---
      const allocation = new Allocation({
        examName,
        date,
        session,
        rooms: roomResults,
        summary,
        attendanceByRoom,
      });
      await allocation.save();

      res.json({
        message: "Allocation successful",
        allocationId: allocation._id,
        summary,
        rooms: roomResults,
        attendanceByRoom,
      });
    } catch (err) {
      console.error("Allocation error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// HISTORY ROUTES
// ============================================================

// GET all past allocations (list view)
app.get("/api/history", isLoggedIn, async (req, res) => {
  try {
    const list = await Allocation.find(
      {},
      { examName: 1, date: 1, session: 1, createdAt: 1, summary: 1 }
    ).sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a specific allocation by ID (full detail)
app.get("/api/history/:id", isLoggedIn, async (req, res) => {
  try {
    const allocation = await Allocation.findById(req.params.id);
    if (!allocation) return res.status(404).json({ error: "Not found" });
    res.json(allocation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PDF GENERATION ROUTES
// ============================================================

// Helper: Write PDF header
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

// --- PDF: Notice Board Sheet ---
app.get("/api/pdf/notice/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) return res.status(404).send("Not found");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="notice_${alloc.examName}.pdf"`
    );

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    writePDFHeader(
      doc,
      "Notice Board – Room Allocation",
      alloc.examName,
      alloc.date,
      alloc.session
    );

    for (const room of alloc.summary) {
      doc.font("Helvetica-Bold").fontSize(13).text(`Room: ${room.roomNo}`);
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`Semesters: ${(room.semesters || []).join(", ") || "—"}`);
      doc.text(`Student Count: ${room.studentCount || 0}`);
      doc.text("USN Ranges:");
      for (const range of (room.usnRanges || [])) {
        doc.text(`  • ${range}`);
      }
      doc.moveDown(1);
    }

    doc.end();
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- PDF: Detailed Seating Layout ---
app.get("/api/pdf/seating/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) return res.status(404).send("Not found");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="seating_${alloc.examName}.pdf"`
    );

    const doc = new PDFDocument({ margin: 40, layout: "landscape" });
    doc.pipe(res);

    writePDFHeader(
      doc,
      "Detailed Seating Arrangement",
      alloc.examName,
      alloc.date,
      alloc.session
    );

    for (const room of alloc.rooms) {
      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(`Room: ${room.roomNo}`, { underline: true });
      doc.moveDown(0.3);

      // Table header
      const colWidths = [60, 175, 175, 175];
      const startX = doc.x;
      let y = doc.y;

      // Header row
      doc.font("Helvetica-Bold").fontSize(10);
      doc.text("Bench", startX, y, { width: colWidths[0] });
      doc.text("LEFT", startX + colWidths[0], y, { width: colWidths[1] });
      doc.text("MIDDLE", startX + colWidths[0] + colWidths[1], y, {
        width: colWidths[2],
      });
      doc.text(
        "RIGHT",
        startX + colWidths[0] + colWidths[1] + colWidths[2],
        y,
        { width: colWidths[3] }
      );
      y += 20;

      doc
        .moveTo(startX, y)
        .lineTo(startX + 585, y)
        .stroke();
      y += 5;

      // Data rows
      doc.font("Helvetica").fontSize(9);
      for (const bench of room.seating) {
        const formatSeat = (s) =>
          s ? `${s.usn}\n${s.name} (${s.semester})` : "—";

        const maxH = 30;
        doc.text(`${bench.bench}`, startX, y, { width: colWidths[0] });
        doc.text(formatSeat(bench.left), startX + colWidths[0], y, {
          width: colWidths[1],
        });
        doc.text(
          formatSeat(bench.middle),
          startX + colWidths[0] + colWidths[1],
          y,
          { width: colWidths[2] }
        );
        doc.text(
          formatSeat(bench.right),
          startX + colWidths[0] + colWidths[1] + colWidths[2],
          y,
          { width: colWidths[3] }
        );
        y += maxH;

        // New page if near bottom
        if (y > 520) {
          doc.addPage({ layout: "landscape" });
          y = 50;
        }
      }

      doc.moveDown(1.5);
    }

    doc.end();
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- PDF: Attendance Sheet ---
app.get("/api/pdf/attendance/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) return res.status(404).send("Not found");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance_${alloc.examName}.pdf"`
    );

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    writePDFHeader(
      doc,
      "Attendance Sheet",
      alloc.examName,
      alloc.date,
      alloc.session
    );

    for (const room of alloc.attendanceByRoom) {
      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(`Room: ${room.roomNo} – Attendance`, { underline: true });
      doc.moveDown(0.5);

      // Table header
      const startX = doc.x;
      let y = doc.y;

      doc.font("Helvetica-Bold").fontSize(10);
      doc.text("S.No", startX, y, { width: 40 });
      doc.text("USN", startX + 40, y, { width: 120 });
      doc.text("Name", startX + 160, y, { width: 180 });
      doc.text("Sem", startX + 340, y, { width: 40 });
      doc.text("Signature", startX + 380, y, { width: 120 });
      y += 18;

      doc
        .moveTo(startX, y)
        .lineTo(startX + 500, y)
        .stroke();
      y += 4;

      doc.font("Helvetica").fontSize(9);
      room.students.forEach((student, idx) => {
        doc.text(`${idx + 1}`, startX, y, { width: 40 });
        doc.text(student.usn, startX + 40, y, { width: 120 });
        doc.text(student.name, startX + 160, y, { width: 180 });
        doc.text(student.semester, startX + 340, y, { width: 40 });
        // Signature box placeholder
        doc
          .rect(startX + 380, y - 2, 110, 16)
          .stroke();
        y += 20;

        if (y > 720) {
          doc.addPage();
          y = 50;
        }
      });

      doc.moveDown(2);
    }

    doc.end();
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ============================================================
// CATCH-ALL: Serve frontend for any unmatched route (SPA support)
// ============================================================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});