// Refactored module (pure move from server.js): POST /api/allocate

const express = require("express");
const xlsx = require("xlsx");
const Allocation = require("../models/Allocation");
const { pool } = require("../config/postgres");
const upload = require("../middleware/upload");
const { isLoggedIn } = require("../middleware/auth");
const { allocateSeats, buildSummary, buildAttendance } = require("../services/seating");
const router = express.Router();

// ============================================================
// MAIN ALLOCATION ROUTE
// POST /api/allocate
// Students fetched from the Postgres student table. Legacy file upload still supported.
// ============================================================

router.post(
  "/api/allocate",
  isLoggedIn,
  (req, res, next) => {
    upload.any()(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
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
      // --- Parse course entries ---
      let courses = [];
      if (Array.isArray(req.body.courses)) {
        courses = req.body.courses.map((c) => ({
          courseName: c.courseName || "",
          courseCode: c.courseCode || "",
          semester: c.semester || "",
          examName: c.examName || "",
        }));
      } else if (req.body.courses && typeof req.body.courses === "object") {
        courses = [{
          courseName: req.body.courses.courseName || "",
          courseCode: req.body.courses.courseCode || "",
          semester: req.body.courses.semester || "",
          examName: req.body.courses.examName || "",
        }];
      } else {
        let i = 0;
        while (req.body[`courses[${i}][semester]`]) {
          courses.push({
            courseName: req.body[`courses[${i}][courseName]`] || "",
            courseCode: req.body[`courses[${i}][courseCode]`] || "",
            semester: req.body[`courses[${i}][semester]`] || "",
            examName: req.body[`courses[${i}][examName]`] || "",
          });
          i++;
        }
      }

      console.log("📋 Parsed courses:", courses);

      if (courses.length === 0) {
        return res.status(400).json({ error: "At least one course entry is required." });
      }

      // Each course entry must carry its own exam name (entry 1 copies the top-level Exam Name)
      for (let i = 0; i < courses.length; i++) {
        if (!courses[i].examName || !courses[i].examName.trim()) {
          return res.status(400).json({
            error: `Exam name is required for course entry ${i + 1}.`,
          });
        }
        courses[i].examName = courses[i].examName.trim();
      }

      // --- Build student groups from DB (with legacy file fallback) ---
      const courseStudents = {};
      const hasFiles = req.files && req.files.length > 0;

      for (let idx = 0; idx < courses.length; idx++) {
        const course = courses[idx];
        const semester = course.semester;
        const groupKey = `${idx}_${semester}`;

        // Section-wise order: all of section A, then B, then C, USN inside.
        const { rows } = await pool.query(
          `SELECT usn, name, section FROM student WHERE semester = $1
           ORDER BY section ASC NULLS LAST, usn ASC`,
          [semester]
        );
        if (rows.length > 0) {
          courseStudents[groupKey] = rows.map((r) => ({ name: r.name, usn: r.usn, section: r.section }));
          console.log(`📚 Loaded ${courseStudents[groupKey].length} students for Sem ${semester} from DB`);
        } else if (hasFiles) {
          const file = req.files.find((f) => f.fieldname === `course_file_${idx}`);
          if (!file) {
            return res.status(400).json({
              error: `No student data in DB for Semester ${semester} and no file uploaded for entry ${idx + 1}.`,
            });
          }
          try {
            const workbook = xlsx.read(file.buffer, { type: "buffer" });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(sheet);
            const students = rows
              .map((row) => ({
                name: (row["Name"] || row["name"] || row["NAME"] || "").toString().trim(),
                usn:  (row["USN"]  || row["usn"]  || row["Usn"]  || "").toString().trim(),
              }))
              .filter((s) => s.name && s.usn);
            if (students.length === 0) {
              return res.status(400).json({ error: `No valid students in file for ${course.courseName || semester}.` });
            }
            courseStudents[groupKey] = students;
          } catch (fileErr) {
            return res.status(400).json({ error: `Failed to parse file: ${fileErr.message}` });
          }
        } else {
          return res.status(400).json({
            error: `No student data found for Semester ${semester}. Please ask admin to upload student data first.`,
          });
        }
      }

      if (Object.keys(courseStudents).length === 0) {
        return res.status(400).json({ error: "No valid students found." });
      }

      console.log(`✅ Student groups:`, Object.entries(courseStudents).map(([k, v]) => ({ group: k, count: v.length })));

      // --- Fetch enabled rooms from DB, sorted ---
      // The seating service expects { roomNo, benches }, so the rows are
      // mapped to that shape — same as the old Mongo documents.
      const { rows } = await pool.query(
        "SELECT room_number, number_of_benches FROM room WHERE is_enabled = true ORDER BY room_number"
      );
      const rooms = rows.map((r) => ({ roomNo: r.room_number, benches: r.number_of_benches }));
      if (rooms.length === 0) {
        return res.status(400).json({ error: "No enabled rooms found. Please ask admin to add rooms first." });
      }

      // --- Run seating algorithm ---
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

module.exports = router;
