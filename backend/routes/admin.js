// Refactored module (pure move from server.js): admin routes (rooms, students, courses)

const express = require("express");
const xlsx = require("xlsx");
const StudentData = require("../models/StudentData");
const { pool } = require("../config/postgres");
const upload = require("../middleware/upload");
const { isAdminLoggedIn } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// ROOM MANAGEMENT ROUTES
// ============================================================

// --- Room rows are mapped to the API shape the frontend uses ---
// Postgres columns are snake_case; the API answers stay camelCase.
// The room number IS the key now (room_number) — there is no Mongo _id.
function toRoomApi(row) {
  return {
    room_number: row.room_number,
    roomNo: row.room_number,
    benches: row.number_of_benches,
    enabled: row.is_enabled,
  };
}

// GET all rooms — accessible by both faculty (Google) and admin
router.get("/api/rooms", async (req, res) => {
  if (!req.isAuthenticated() && !(req.session && req.session.adminUser)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  try {
    const { rows } = await pool.query(
      "SELECT room_number, number_of_benches, is_enabled FROM room ORDER BY room_number"
    );
    res.json(rows.map(toRoomApi));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a new room (admin only)
router.post("/api/rooms", isAdminLoggedIn, async (req, res) => {
  try {
    const { roomNo, benches, enabled } = req.body;
    if (!roomNo || benches === undefined || benches === null || benches === "") {
      return res.status(400).json({ error: "roomNo and benches are required." });
    }
    const { rows } = await pool.query(
      "INSERT INTO room (room_number, number_of_benches, is_enabled) VALUES ($1, $2, $3) RETURNING room_number, number_of_benches, is_enabled",
      [roomNo.trim(), Number(benches), enabled === undefined ? true : enabled]
    );
    res.json({ message: "Room added", room: toRoomApi(rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "A room with this number already exists." });
    }
    res.status(400).json({ error: err.message });
  }
});

// PUT update a room (admin only) — :id is the room number, which can itself change.
router.put("/api/rooms/:id", isAdminLoggedIn, async (req, res) => {
  try {
    const { roomNo, benches, enabled } = req.body;
    if (!roomNo || benches === undefined || benches === null || benches === "") {
      return res.status(400).json({ error: "roomNo and benches are required." });
    }
    const { rows } = await pool.query(
      "UPDATE room SET room_number = $1, number_of_benches = $2, is_enabled = $3 WHERE room_number = $4 RETURNING room_number, number_of_benches, is_enabled",
      [roomNo.trim(), Number(benches), enabled, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Room not found." });
    }
    res.json({ message: "Room updated", room: toRoomApi(rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "A room with this number already exists." });
    }
    res.status(400).json({ error: err.message });
  }
});

// DELETE a room (admin only) — :id is the room number.
router.delete("/api/rooms/:id", isAdminLoggedIn, async (req, res) => {
  try {
    await pool.query("DELETE FROM room WHERE room_number = $1", [req.params.id]);
    res.json({ message: "Room deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STUDENT DATA ROUTES (Admin only)
// ============================================================

// Upload student list for a semester (replaces existing)
router.post(
  "/api/admin/students/upload",
  isAdminLoggedIn,
  (req, res, next) => {
    upload.single("studentFile")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const { semester } = req.body;
      if (!semester) return res.status(400).json({ error: "Semester is required." });
      if (!req.file) return res.status(400).json({ error: "Student file is required." });

      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet);

      const students = rows
        .map((row) => ({
          name: (row["Name"] || row["name"] || row["NAME"] || "").toString().trim(),
          usn:  (row["USN"]  || row["usn"]  || row["Usn"]  || "").toString().trim(),
        }))
        .filter((s) => s.name && s.usn);

      if (students.length === 0) {
        return res.status(400).json({ error: "No valid students found. Ensure columns are 'Name' and 'USN'." });
      }

      // Upsert: replace existing data for this semester
      await StudentData.findOneAndUpdate(
        { semester },
        { semester, students, uploadedAt: new Date() },
        { upsert: true, new: true }
      );

      res.json({ success: true, semester, count: students.length });
    } catch (err) {
      console.error("Student upload error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET student list for a semester (admin view)
router.get("/api/admin/students/:semester", isAdminLoggedIn, async (req, res) => {
  try {
    const data = await StudentData.findOne({ semester: req.params.semester });
    if (!data) return res.json({ semester: req.params.semester, students: [] });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all semesters that have student data (for admin overview)
router.get("/api/admin/students", isAdminLoggedIn, async (req, res) => {
  try {
    const data = await StudentData.find({}, { semester: 1, uploadedAt: 1, "students": { $slice: 0 } })
      .lean()
      .then(docs => docs.map(d => ({ semester: d.semester, uploadedAt: d.uploadedAt, count: 0 })));
    // Get counts separately
    const counts = await StudentData.aggregate([
      { $project: { semester: 1, uploadedAt: 1, count: { $size: "$students" } } }
    ]);
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE student data for a semester
router.delete("/api/admin/students/:semester", isAdminLoggedIn, async (req, res) => {
  try {
    await StudentData.findOneAndDelete({ semester: req.params.semester });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// COURSE DATA ROUTES (Admin only for write, Faculty for read)
// ============================================================

// --- Course rows are mapped to the API shape the frontend uses ---
// Postgres columns are snake_case; the API answers stay camelCase.
// The course code IS the key now (course_id) — there is no Mongo _id.
function toCourseApi(row) {
  return {
    course_id: row.course_id,
    semester: row.semester,
    courseName: row.course_name,
    courseCode: row.course_id,
  };
}

// GET courses for a semester (faculty + admin)
router.get("/api/courses/:semester", async (req, res) => {
  if (!req.isAuthenticated() && !(req.session && req.session.adminUser)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  try {
    const { rows } = await pool.query(
      "SELECT course_id, course_name, semester FROM course WHERE semester = $1 ORDER BY course_name",
      [req.params.semester]
    );
    res.json(rows.map(toCourseApi));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all courses grouped by semester (admin overview)
router.get("/api/admin/courses", isAdminLoggedIn, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT course_id, course_name, semester FROM course ORDER BY semester, course_name"
    );
    res.json(rows.map(toCourseApi));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a course (admin)
router.post("/api/admin/courses", isAdminLoggedIn, async (req, res) => {
  try {
    const { semester, courseName, courseCode } = req.body;
    if (!semester || !courseName || !courseCode) {
      return res.status(400).json({ error: "semester, courseName, and courseCode are required." });
    }
    const { rows } = await pool.query(
      "INSERT INTO course (course_id, course_name, semester) VALUES ($1, $2, $3) RETURNING course_id, course_name, semester",
      [courseCode.trim(), courseName.trim(), semester]
    );
    res.json({ success: true, course: toCourseApi(rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "A course with this code already exists." });
    }
    res.status(400).json({ error: err.message });
  }
});

// PUT update a course (admin) — :id is the course code, which can itself change.
router.put("/api/admin/courses/:id", isAdminLoggedIn, async (req, res) => {
  try {
    const { semester, courseName, courseCode } = req.body;
    const { rows } = await pool.query(
      "UPDATE course SET course_id = $1, course_name = $2, semester = $3 WHERE course_id = $4 RETURNING course_id, course_name, semester",
      [courseCode.trim(), courseName.trim(), semester, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Course not found." });
    }
    res.json({ success: true, course: toCourseApi(rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "A course with this code already exists." });
    }
    res.status(400).json({ error: err.message });
  }
});

// DELETE a course (admin) — :id is the course code.
router.delete("/api/admin/courses/:id", isAdminLoggedIn, async (req, res) => {
  try {
    await pool.query("DELETE FROM course WHERE course_id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
