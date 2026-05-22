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
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 5000;

// Trust Render's reverse proxy so secure cookies work correctly on HTTPS
app.set("trust proxy", 1);

// ============================================================
// MIDDLEWARE SETUP
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security headers (helmet) — sets X-Frame-Options, X-Content-Type-Options,
// Content-Security-Policy, and more in one line
app.use(helmet({
  // Allow inline scripts/styles needed by the frontend
  contentSecurityPolicy: false,
}));

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
// RATE LIMITING
// ============================================================

// General API limiter: 100 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again after 15 minutes." },
});
app.use("/api/", apiLimiter);

// Stricter limiter for auth: 20 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again after 15 minutes." },
});
app.use("/auth/", authLimiter);

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
  // Course details per semester
  courses: [
    {
      courseName: String,
      courseCode: String,
      semester: String, // I, II, III, IV, V, VI, VII, VIII
    },
  ],
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
  // Saved attendance (marked by faculty)
  attendance: [
    {
      roomNo: String,
      status: { type: String, enum: ["draft", "saved", "finalized"], default: "draft" },
      savedAt: { type: Date, default: Date.now },
      students: [
        {
          usn: String,
          name: String,
          semester: String,
          present: { type: Boolean, default: true },
        },
      ],
    },
  ],
});
const Allocation = mongoose.model("Allocation", allocationSchema);

// ============================================================
// SESSION SETUP (uses MongoDB to persist sessions)
// ============================================================

// Fail fast if SESSION_SECRET is not set in production
if (!process.env.SESSION_SECRET) {
  console.error("❌ SESSION_SECRET environment variable is not set. Refusing to start.");
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === "production";

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI || "mongodb://localhost:27017/aiml_seats",
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,              // JS cannot read the cookie (blocks XSS theft)
      secure: isProduction,        // HTTPS only in production
      sameSite: "lax",             // Blocks cross-site request forgery
    },
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
      const email = profile.emails && profile.emails[0] && profile.emails[0].value;
      if (!email || !email.endsWith("@vvce.ac.in")) {
        return done(null, false, { message: "Access restricted to @vvce.ac.in accounts only." });
      }
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
  passport.authenticate("google", { failureRedirect: "/?error=unauthorized_domain" }),
  (req, res) => {
    // Redirect to frontend dashboard after successful login
    res.redirect(process.env.FRONTEND_URL || "http://localhost:3000");
  }
);

// Logout
app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destroy error:", err);
      }
      res.clearCookie("connect.sid"); // Remove the session cookie from browser
      res.redirect("/");
    });
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max per file
  fileFilter: (req, file, cb) => {
    const allowedExt = [".xlsx", ".xls", ".csv"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${ext}. Only .xlsx, .xls, .csv are allowed.`));
    }
  },
});

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

function allocateSeats(semesterStudents, rooms, groupToSemester) {

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
  // Uses groupToSemester to set the display semester label.
  function getNextStudent(sem) {
    if (!sem || queues[sem] >= batches[sem].length) return null;
    const student = batches[sem][queues[sem]++];
    const displaySem = (groupToSemester && groupToSemester[sem]) || sem;
    return { ...student, semester: displaySem };
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

  // Pop N students from a semester queue. Returns array (may contain nulls at end).
  function getNextNStudents(sem, n) {
    const result = [];
    for (let i = 0; i < n; i++) {
      result.push(getNextStudent(sem));
    }
    return result;
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
  // STEP 4 — ROOM-BY-ROOM ALLOCATION (COLUMN-FIRST FILL)
  //
  // SINGLE COURSE (globalSemB is null):
  //   Each bench: Left=A, Middle=EMPTY, Right=A
  //   Fill Left column top-to-bottom, then Right column top-to-bottom
  //   12 students per row, 36 per room
  //
  // TWO COURSES (normal ABA/BAB):
  //   Each bench has 3 seats: Left, Middle, Right.
  //   ABA -> Left=A, Middle=B, Right=A
  //   BAB -> Left=B, Middle=A, Right=B
  //   18 students per row, 54 per room
  // =========================================================

  const singleCourse = !globalSemB; // Only one group uploaded
  const ROWS_PER_ROOM = 3;
  const BENCHES_PER_ROW = 6; // Fixed: 18 benches / 3 rows
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
    const roomStartsWithABA = roomIdx % 2 === 0;

    for (let row = 0; row < ROWS_PER_ROOM; row++) {

      if (!hasStudentsLeft()) break;

      if (singleCourse) {
        // SINGLE COURSE: Left=A, Middle=null, Right=A (column-first)
        const leftCol = getNextNStudents(globalSemA, BENCHES_PER_ROW);
        const rightCol = getNextNStudents(globalSemA, BENCHES_PER_ROW);

        for (let b = 0; b < BENCHES_PER_ROW; b++) {
          const benchNum = row * BENCHES_PER_ROW + b + 1;
          const benchData = {
            row: row + 1,
            bench: benchNum,
            left: leftCol[b],
            middle: null,
            right: rightCol[b],
          };
          if (benchData.left || benchData.right) {
            roomResult.seating.push(benchData);
          }
        }
      } else {
        // TWO COURSES: ABA/BAB pattern
        const rowIsABA = roomStartsWithABA
          ? row % 2 === 0
          : row % 2 !== 0;

        // Determine which batch goes to which column
        const colSems = rowIsABA
          ? [globalSemA, globalSemB, globalSemA]
          : [globalSemB, globalSemA, globalSemB];

        // Fill columns top-to-bottom: get N students for each column
        const leftCol = getNextNStudents(colSems[0], BENCHES_PER_ROW);
        const middleCol = getNextNStudents(colSems[1], BENCHES_PER_ROW);
        const rightCol = getNextNStudents(colSems[2], BENCHES_PER_ROW);

        // Assemble benches from the three columns
        for (let b = 0; b < BENCHES_PER_ROW; b++) {
          const benchNum = row * BENCHES_PER_ROW + b + 1;

          const benchData = {
            row: row + 1,
            bench: benchNum,
            left: leftCol[b],
            middle: middleCol[b],
            right: rightCol[b],
          };

          // Only push if at least one seat is filled
          if (benchData.left || benchData.middle || benchData.right) {
            roomResult.seating.push(benchData);
          }
        }
      } // end else (two courses)
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
// Accepts: exam details + course entries (each with courseName, courseCode, semester, file)
// ============================================================

app.post(
  "/api/allocate",
  isLoggedIn,
  (req, res, next) => {
    upload.any()(req, res, (err) => {
      if (err) {
        // Multer errors (file too large, wrong type, etc.)
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const { examName, date, session } = req.body;

      if (!examName || !date || !session) {
        return res
          .status(400)
          .json({ error: "examName, date, and session are required." });
      }

      // --- Parse course entries from form data ---
      // Express with extended:true parses courses[0][semester] into req.body.courses array
      let courses = [];
      
      if (Array.isArray(req.body.courses)) {
        // Already parsed as array by Express
        courses = req.body.courses.map((c) => ({
          courseName: c.courseName || "",
          courseCode: c.courseCode || "",
          semester: c.semester || "",
        }));
      } else if (req.body.courses && typeof req.body.courses === "object") {
        // Single entry parsed as object
        courses = [
          {
            courseName: req.body.courses.courseName || "",
            courseCode: req.body.courses.courseCode || "",
            semester: req.body.courses.semester || "",
          },
        ];
      } else {
        // Fallback: try bracket notation (in case multer doesn't parse nested)
        let i = 0;
        while (req.body[`courses[${i}][semester]`]) {
          courses.push({
            courseName: req.body[`courses[${i}][courseName]`] || "",
            courseCode: req.body[`courses[${i}][courseCode]`] || "",
            semester: req.body[`courses[${i}][semester]`] || "",
          });
          i++;
        }
      }

      console.log("📋 Parsed courses:", courses);

      if (courses.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one course entry is required." });
      }

      if (!req.files || req.files.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one student file is required." });
      }

      // --- Group students by COURSE ENTRY (not semester) for ABA/BAB mixing ---
      // Each course entry = one group. The semester is stored as metadata for display.
      // Key format: "idx_semester" to keep groups unique even if same semester
      const courseStudents = {}; // { "0_IV": [...], "1_VI": [...] }

      for (let idx = 0; idx < courses.length; idx++) {
        const course = courses[idx];
        const semester = course.semester;
        const groupKey = `${idx}_${semester}`; // Unique per course entry

        // Find the file for this course entry
        const file = req.files.find((f) => f.fieldname === `course_file_${idx}`);
        if (!file) {
          return res.status(400).json({
            error: `No file uploaded for course entry ${idx + 1} (${course.courseName || semester}).`,
          });
        }

        try {
          const workbook = xlsx.read(file.buffer, { type: "buffer" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = xlsx.utils.sheet_to_json(sheet);

          const students = rows
            .map((row) => {
              const name = row["Name"] || row["name"] || row["NAME"] || "";
              const usn = row["USN"] || row["usn"] || row["Usn"] || "";
              return { name: name.trim(), usn: usn.trim() };
            })
            .filter((s) => s.name && s.usn);

          if (students.length === 0) {
            return res.status(400).json({
              error: `No valid students found in file for ${course.courseName || semester}.`,
            });
          }

          courseStudents[groupKey] = students;
        } catch (fileErr) {
          console.error(`Error parsing file ${file.originalname}:`, fileErr);
          return res.status(400).json({
            error: `Failed to parse file ${file.originalname}: ${fileErr.message}`,
          });
        }
      }

      if (Object.keys(courseStudents).length === 0) {
        return res
          .status(400)
          .json({ error: "No valid students found in uploaded files." });
      }

      console.log(
        `✅ Parsed students into course groups:`,
        Object.entries(courseStudents).map(([key, students]) => ({
          group: key,
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

      // --- Run seating algorithm with course-grouped data ---
      // The algorithm uses group keys internally. We map the semester from the key
      // so that the stored data shows the semester label (e.g., "IV") not the internal key.
      const groupToSemester = {};
      for (let idx = 0; idx < courses.length; idx++) {
        groupToSemester[`${idx}_${courses[idx].semester}`] = courses[idx].semester;
      }
      const roomResults = allocateSeats(courseStudents, rooms, groupToSemester);

      // --- Build summary and attendance ---
      const summary = buildSummary(roomResults);
      const attendanceByRoom = buildAttendance(roomResults);

      // --- If editing, delete the old allocation ---
      const replaceId = req.body.replaceId;
      if (replaceId) {
        try {
          await Allocation.findByIdAndDelete(replaceId);
          console.log(`🔄 Replaced old allocation: ${replaceId}`);
        } catch (delErr) {
          console.warn("Could not delete old allocation:", delErr.message);
        }
      }

      // --- Save to MongoDB ---
      const allocation = new Allocation({
        examName,
        date,
        session,
        courses,
        rooms: roomResults,
        summary,
        attendanceByRoom,
      });
      await allocation.save();

      res.json({
        message: "Allocation successful",
        allocationId: allocation._id,
        courses,
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
      { examName: 1, date: 1, session: 1, createdAt: 1, summary: 1, courses: 1 }
    ).sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE an allocation
app.delete("/api/history/:id", isLoggedIn, async (req, res) => {
  try {
    await Allocation.findByIdAndDelete(req.params.id);
    res.json({ message: "Allocation deleted" });
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
// ATTENDANCE SAVE ROUTE
// ============================================================

// POST save attendance for a specific room in an allocation
app.post("/api/attendance/save", isLoggedIn, async (req, res) => {
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

// --- PDF: Absent Report ---
app.get("/api/pdf/absent-report/:id", isLoggedIn, async (req, res) => {
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
app.get("/api/pdf/absent-report/:id/course/:courseIdx", isLoggedIn, async (req, res) => {
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
app.get("/api/pdf/absent-report/:id/room/:roomNo", isLoggedIn, async (req, res) => {
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

// Logo file paths (resolved once)
const LOGO_VVCE = path.join(__dirname, "assets", "vvce.jpg");
const LOGO_AIML = path.join(__dirname, "assets", "aiml.jpg");

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
app.get("/api/pdf/attendance/:id", isLoggedIn, async (req, res) => {
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

// ============================================================
// ATTENDANCE — ABSENT STUDENTS PDF
// POST /api/attendance/absent-pdf
// Body: { examName, date, session, roomNo, courses, absentStudents }
// absentStudents: [{ name, usn, semester }]
// ============================================================

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

app.post("/api/attendance/absent-pdf", isLoggedIn, async (req, res) => {
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

// ============================================================
// CATCH-ALL: Serve frontend for any unmatched route (SPA support)
// ============================================================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ============================================================
// GLOBAL ERROR HANDLER
// Catches any unhandled errors — never leaks stack traces in production
// ============================================================

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  const isDev = process.env.NODE_ENV !== "production";
  res.status(err.status || 500).json({
    error: isDev ? err.message : "An internal server error occurred.",
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
