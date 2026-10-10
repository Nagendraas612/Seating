// Refactored module (pure move from server.js): admin routes (rooms, students, courses)

const express = require("express");
const xlsx = require("xlsx");
const Room = require("../models/Room");
const StudentData = require("../models/StudentData");
const CourseData = require("../models/CourseData");
const upload = require("../middleware/upload");
const { isAdminLoggedIn } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// ROOM MANAGEMENT ROUTES
// ============================================================

// GET all rooms — accessible by both faculty (Google) and admin
router.get("/api/rooms", async (req, res) => {
  if (!req.isAuthenticated() && !(req.session && req.session.adminUser)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  try {
    const rooms = await Room.find().sort({ roomNo: 1 });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a new room (admin only)
router.post("/api/rooms", isAdminLoggedIn, async (req, res) => {
  try {
    const { roomNo, benches, enabled } = req.body;
    const room = new Room({ roomNo, benches: Number(benches), enabled });
    await room.save();
    res.json({ message: "Room added", room });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update a room (admin only)
router.put("/api/rooms/:id", isAdminLoggedIn, async (req, res) => {
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

// DELETE a room (admin only)
router.delete("/api/rooms/:id", isAdminLoggedIn, async (req, res) => {
  try {
    await Room.findByIdAndDelete(req.params.id);
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

// GET courses for a semester (faculty + admin)
router.get("/api/courses/:semester", async (req, res) => {
  if (!req.isAuthenticated() && !(req.session && req.session.adminUser)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  try {
    const courses = await CourseData.find({ semester: req.params.semester }).sort({ courseName: 1 });
    res.json(courses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all courses grouped by semester (admin overview)
router.get("/api/admin/courses", isAdminLoggedIn, async (req, res) => {
  try {
    const courses = await CourseData.find().sort({ semester: 1, courseName: 1 });
    res.json(courses);
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
    const course = new CourseData({ semester, courseName: courseName.trim(), courseCode: courseCode.trim() });
    await course.save();
    res.json({ success: true, course });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update a course (admin)
router.put("/api/admin/courses/:id", isAdminLoggedIn, async (req, res) => {
  try {
    const { semester, courseName, courseCode } = req.body;
    const course = await CourseData.findByIdAndUpdate(
      req.params.id,
      { semester, courseName: courseName.trim(), courseCode: courseCode.trim() },
      { new: true }
    );
    res.json({ success: true, course });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE a course (admin)
router.delete("/api/admin/courses/:id", isAdminLoggedIn, async (req, res) => {
  try {
    await CourseData.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
