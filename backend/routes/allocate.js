// Refactored module (pure move from server.js): POST /api/allocate

const express = require("express");
const { pool } = require("../config/postgres");
const { deleteAllocation } = require("../utils/allocationLoader");
const upload = require("../middleware/upload");
const { isLoggedIn } = require("../middleware/auth");
const { allocateSeats, buildSummary, buildAttendance } = require("../services/seating");
const router = express.Router();

// ============================================================
// MAIN ALLOCATION ROUTE
// POST /api/allocate
// Students come from the Postgres student table only. The legacy per-course
// file upload was removed in stage 4 (faculty decision 2026-11-22) — it can
// return later as a designed feature, not a fallback.
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

      // Seating supports at most 3 semesters at a time (faculty decision
      // 2026-11-22: 4 semesters never run together). The cap is on DISTINCT
      // semesters — two course entries in one semester are a single group.
      // Refused here, before any student is loaded or anything is saved.
      const distinctSemesters = [...new Set(courses.map((c) => c.semester))];
      if (distinctSemesters.length > 3) {
        return res.status(400).json({
          error: `Seating supports up to 3 semesters at a time. You selected ${distinctSemesters.length} (${distinctSemesters.join(", ")}).`,
        });
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

      // --- Build student groups from the DB ---
      const courseStudents = {};

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
      const { rooms: roomResults, unseated, unseatedTotal } = allocateSeats(courseStudents, rooms, groupToSemester);

      // Overflow (stage 5): students who did not fit the rooms are reported,
      // never silently dropped. The allocation still saves (warn, don't block).
      if (unseatedTotal > 0) {
        console.warn(`⚠ Overflow: ${unseatedTotal} student(s) could not be seated:`,
          unseated.map((g) => `Sem ${g.semester}: ${g.students.length}`).join(", "));
      }

      // --- Build summary and attendance ---
      const summary = buildSummary(roomResults);
      const attendanceByRoom = buildAttendance(roomResults);

      // --- Save to Postgres, all in one transaction ---
      // Exam row + course mappings + one seating row per occupied seat.
      // Summary and attendance lists are NOT stored — they are derived
      // from the seating rows when read. The exam is Published at once,
      // keeping today's behaviour (no Draft/Published review step yet).
      const client = await pool.connect();
      let examId;
      try {
        await client.query("BEGIN");

        // Re-generate replaces the old allocation (children first: the
        // tables have no ON DELETE CASCADE). A bad id is ignored, like before.
        const replaceId = req.body.replaceId;
        if (replaceId) {
          if (await deleteAllocation(replaceId, client)) {
            console.log(`🔄 Replaced old allocation: ${replaceId}`);
          } else {
            console.warn("Could not delete old allocation:", replaceId);
          }
        }

        const { rows: [exam] } = await client.query(
          `INSERT INTO exam (exam_name, exam_date, session, exam_status)
           VALUES ($1, $2, $3, 'Published') RETURNING exam_id`,
          [examName, date, session]
        );
        examId = exam.exam_id;

        // Mappings only for codes that exist in the course table — a typed
        // code with no course row cannot be linked, so it is skipped
        // (the in-memory course list below still carries it for display).
        const { rows: existing } = await client.query(
          "SELECT course_id FROM course WHERE course_id = ANY($1)",
          [courses.map((c) => c.courseCode)]
        );
        const existingCodes = new Set(existing.map((r) => r.course_id));
        for (const c of courses) {
          if (!existingCodes.has(c.courseCode)) {
            console.warn(`Course code not in course table, mapping skipped: ${c.courseCode}`);
            continue;
          }
          await client.query(
            `INSERT INTO exam_course_mapping (exam_id, course_id, semester, exam_name)
             VALUES ($1, $2, $3, $4) ON CONFLICT (exam_id, course_id) DO NOTHING`,
            [examId, c.courseCode, c.semester, c.examName]
          );
        }

        // Group label per semester, from the course entry order: first
        // entry A, second B, third C. (Two entries sharing a semester
        // share a label — the label is a per-run record, not a key.)
        const groupLabelBySemester = {};
        courses.forEach((c, i) => {
          if (!(c.semester in groupLabelBySemester)) groupLabelBySemester[c.semester] = "ABC"[i] || null;
        });

        // One batched INSERT for all occupied seats (empty seats are not
        // stored — a missing seat position reads as empty).
        const seatValues = [];
        const seatParams = [];
        let p = 1;
        for (const room of roomResults) {
          for (const bench of room.seating) {
            for (const pos of ["left", "middle", "right"]) {
              const s = bench[pos];
              if (!s || !s.usn) continue;
              seatValues.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
              seatParams.push(
                examId,
                room.roomNo,
                bench.bench,
                pos[0].toUpperCase() + pos.slice(1),
                s.usn,
                groupLabelBySemester[s.semester] || null
              );
            }
          }
        }
        if (seatValues.length > 0) {
          await client.query(
            `INSERT INTO seating_allocation (exam_id, room_number, bench_number, seat_position, student_usn, group_label) VALUES ${seatValues.join(", ")}`,
            seatParams
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      res.json({
        message: "Allocation successful",
        allocationId: examId,
        courses,
        summary,
        rooms: roomResults,
        attendanceByRoom,
        unseated,
        unseatedTotal,
      });
    } catch (err) {
      console.error("Allocation error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
