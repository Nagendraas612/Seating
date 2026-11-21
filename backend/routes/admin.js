// Refactored module (pure move from server.js): admin routes (rooms, students, courses)

const express = require("express");
const { pool } = require("../config/postgres");
const { parseStudentWorkbook } = require("../utils/studentUpload");
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

      let parsed;
      try {
        parsed = parseStudentWorkbook(req.file.buffer);
      } catch (err) {
        return res.status(400).json({ error: "Could not read that file: " + err.message });
      }
      const { students, skipped } = parsed;

      if (students.length === 0) {
        return res.status(400).json({ error: "No valid students found. The sheet needs USN, Name and Email columns (Section and Batch are recommended)." });
      }

      // Replace this semester's students in ONE transaction: if anything
      // fails halfway, the old list stays untouched. A USN that already
      // lives in another semester moves here — one student, one semester.
      const client = await pool.connect();
      let moved = 0;
      try {
        await client.query("BEGIN");
        // Students in this file who currently sit in ANOTHER semester will
        // move here — count them so the admin sees the move instead of a
        // semester silently vanishing from the overview.
        const movedRes = await client.query(
          "SELECT COUNT(*)::int AS moved FROM student WHERE usn = ANY($1) AND semester <> $2",
          [students.map((s) => s.usn), semester]
        );
        moved = movedRes.rows[0].moved;
        await client.query("DELETE FROM student WHERE semester = $1", [semester]);
        for (const s of students) {
          await client.query(
            `INSERT INTO student (usn, name, batch, semester, section, email_id, uploaded_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (usn) DO UPDATE SET
               name = EXCLUDED.name, batch = EXCLUDED.batch,
               semester = EXCLUDED.semester, section = EXCLUDED.section,
               email_id = EXCLUDED.email_id, uploaded_at = NOW()`,
            [s.usn, s.name, s.batch, semester, s.section, s.email]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0);
      if (totalSkipped > 0) {
        console.log(`Student upload: ${totalSkipped} rows skipped`, skipped);
      }
      res.json({ success: true, semester, count: students.length, skipped: totalSkipped, moved });
    } catch (err) {
      console.error("Student upload error:", err);
      if (err.code === "23505") {
        return res.status(400).json({ error: "An email in this file already belongs to another student." });
      }
      res.status(500).json({ error: err.message });
    }
  }
);

// GET student list for a semester (admin view)
// Section-wise order: all of section A, then B, then C, USN order inside.
router.get("/api/admin/students/:semester", isAdminLoggedIn, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT usn, name, section, batch, email_id, uploaded_at
       FROM student WHERE semester = $1
       ORDER BY section ASC NULLS LAST, usn ASC`,
      [req.params.semester]
    );
    res.json({
      semester: req.params.semester,
      students: rows.map((r) => ({ name: r.name, usn: r.usn, section: r.section, batch: r.batch, email: r.email_id })),
      uploadedAt: rows.length ? rows[0].uploaded_at : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all semesters that have student data (for admin overview)
router.get("/api/admin/students", isAdminLoggedIn, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT semester, COUNT(*)::int AS count, MAX(uploaded_at) AS "uploadedAt"
       FROM student GROUP BY semester ORDER BY semester`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE student data for a semester
router.delete("/api/admin/students/:semester", isAdminLoggedIn, async (req, res) => {
  try {
    await pool.query("DELETE FROM student WHERE semester = $1", [req.params.semester]);
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
