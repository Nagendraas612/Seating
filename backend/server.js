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
          row: Number,
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
// HELPER FUNCTIONS
// ============================================================

/**
 * Extract batch year from USN format: 4VV24CI001 → "24"
 * USN Format: [digit][2 letters][2 digits - BATCH YEAR][2 letters - BRANCH][3 digits]
 * Examples:
 *   4VV24CI001 → batch "24" (2024 admission)
 *   4VV23CS001 → batch "23" (2023 admission)
 *   4TV24CS001 → batch "24" (2024 admission)
 */
function extractBatchFromUSN(usn) {
  if (!usn || typeof usn !== "string") return null;
  const match = usn.match(/^\d[A-Z]{2}(\d{2})[A-Z]{2}\d{3}$/);
  return match ? match[1] : null;
}

/**
 * Parse student list and group by batch year (extracted from USN)
 * @param {Array} students - Array of { name, usn }
 * @returns {Object} - { "24": [students], "23": [students], ... }
 */
function groupStudentsByBatch(students) {
  const batchMap = {};
  
  for (const student of students) {
    const batch = extractBatchFromUSN(student.usn);
    
    if (!batch) {
      console.warn(`Invalid USN format or batch not found: ${student.usn}`);
      continue;
    }
    
    if (!batchMap[batch]) {
      batchMap[batch] = [];
    }
    batchMap[batch].push(student);
  }
  
  return batchMap;
}

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

    const semMap = {};

    for (const bench of room.seating) {

      for (const pos of ["left", "middle", "right"]) {

        const s = bench[pos];

        // Skip invalid seats safely
        if (
          !s ||
          typeof s !== "object" ||
          !s.usn ||
          !s.semester
        ) {
          continue;
        }

        const sem = String(s.semester).trim();

        // Ensure array exists
        if (!Array.isArray(semMap[sem])) {
          semMap[sem] = [];
        }

        semMap[sem].push(s.usn);
      }
    }

    const semesters = Object.keys(semMap);

    const usnRanges = semesters.map((sem) => {

      const usns = semMap[sem].sort();

      return `${sem}: ${usns[0]} – ${usns[usns.length - 1]}`;
    });

    const studentCount = semesters.reduce(
      (sum, sem) => sum + semMap[sem].length,
      0
    );

    return {
      roomNo: room.roomNo,
      semesters,
      usnRanges,
      studentCount,
    };
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
// Accepts: exam details + multiple Excel/CSV files (students grouped by batch year via USN)
// ============================================================

app.post(
  "/api/allocate",
  isLoggedIn,
  upload.array("semesterFiles"), // field name "semesterFiles", multiple files allowed
  async (req, res) => {
    try {
      const { examName, date, session } = req.body;

      if (!examName || !date || !session) {
        return res
          .status(400)
          .json({ error: "examName, date, and session are required." });
      }

      if (!req.files || req.files.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one student file is required." });
      }

      // --- Collect all students from all uploaded files ---
      const allStudents = [];

      for (const file of req.files) {
        try {
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

          allStudents.push(...students);
        } catch (fileErr) {
          console.error(`Error parsing file ${file.originalname}:`, fileErr);
          return res.status(400).json({
            error: `Failed to parse file ${file.originalname}: ${fileErr.message}`,
          });
        }
      }

      if (allStudents.length === 0) {
        return res
          .status(400)
          .json({ error: "No valid students found in uploaded files." });
      }

      // --- GROUP STUDENTS BY BATCH YEAR (extracted from USN) ---
      const batchStudents = groupStudentsByBatch(allStudents);

      if (Object.keys(batchStudents).length === 0) {
        return res.status(400).json({
          error:
            "No valid USN formats found. Expected format: 4VV24CI001 (year in positions 4-5)",
        });
      }

      console.log(
        `✅ Parsed ${allStudents.length} students into batches:`,
        Object.entries(batchStudents).map(([batch, students]) => ({
          batch,
          count: students.length,
        }))
      );

      // --- Fetch enabled rooms from DB, sorted ---
      const rooms = await Room.find({ enabled: true }).sort({ roomNo: 1 });
      if (rooms.length === 0) {
        return res
          .status(400)
          .json({ error: "No enabled rooms found. Please add rooms first." });
      }

      // --- Run seating algorithm with batch data ---
      const roomResults = allocateSeats(batchStudents, rooms);

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

// Logo file paths (resolved once)
const LOGO_VVCE = path.join(__dirname, "assets", "vvce.jpeg");
const LOGO_AIML = path.join(__dirname, "assets", "aiml.jpeg");

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
function renderClassroom(doc, room, examName) {
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

  // ── Exam name (left) + Room number (centered) ──────────────
  const labelY = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(examName || "—", margin, labelY, {
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

// --- PDF: Notice Board Sheet ---
app.get("/api/pdf/notice/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="notice_${alloc.examName || "exam"}.pdf"`
    );

    const doc = new PDFDocument({ margin: 50 });
    
    // Handle errors
    doc.on("error", (err) => {
      console.error("PDF generation error:", err);
      res.status(500).json({ error: "PDF generation failed" });
    });
    
    doc.pipe(res);

    writePDFHeader(
      doc,
      "Notice Board – Room Allocation",
      alloc.examName || "Unknown Exam",
      alloc.date || "—",
      alloc.session || "—"
    );

    if (!alloc.summary || alloc.summary.length === 0) {
      doc.fontSize(12).text("No allocation data available.", { align: "center" });
      doc.end();
      return;
    }

    for (const room of alloc.summary) {
      doc.font("Helvetica-Bold").fontSize(13).text(`Room: ${room.roomNo || "—"}`);
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`Semesters: ${(room.semesters || []).join(", ") || "—"}`);
      doc.text(`Student Count: ${room.studentCount || 0}`);
      doc.text("USN Ranges:");
      
      if (room.usnRanges && room.usnRanges.length > 0) {
        for (const range of room.usnRanges) {
          doc.text(`  • ${range}`);
        }
      } else {
        doc.text("  • No students");
      }
      doc.moveDown(1);
    }

    doc.end();
  } catch (err) {
    console.error("Notice PDF error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- PDF: Detailed Seating Layout (Classroom Template) ---
app.get("/api/pdf/seating/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="seating_${alloc.examName || "exam"}.pdf"`
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

      // ── Render classroom grid ───────────────────────────────
      renderClassroom(doc, room, alloc.examName);
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
app.get("/api/pdf/attendance/:id", isLoggedIn, async (req, res) => {
  try {
    const alloc = await Allocation.findById(req.params.id);
    if (!alloc) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance_${alloc.examName || "exam"}.pdf"`
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