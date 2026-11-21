// Loads an allocation (exam + seating + attendance) from Postgres and
// rebuilds it in the shape the app already uses — the same shape the old
// Mongo Allocation document had. History, PDFs and attendance all read
// through here, so their code does not change.
//
// Summary and attendance lists are DERIVED from the seating rows with the
// existing builders (buildSummary / buildAttendance), never stored.
// Only occupied seats are stored: a bench position with no row reads as
// an empty seat, and a bench with no occupied seat is omitted, exactly
// like the old document.

const { pool } = require("../config/postgres");
const { buildSummary, buildAttendance } = require("../services/seating");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

// PG record_status ('Draft'/'Saved'/'Finalized') -> API ('draft'/'saved'/'finalized')
function toApiStatus(s) {
  return String(s || "Draft").toLowerCase();
}

const SEAT_KEY = { Left: "left", Middle: "middle", Right: "right" };

// Rebuild the rooms array from seating rows (each row carries room_number,
// bench_number, seat_position, student_usn, name, semester, benches).
// Row is derived from the bench number: benches 1-6 are row 1, 7-12 row 2,
// 13-18 row 3 — the same layout the seating algorithm writes.
function buildRoomsFromRows(rows) {
  const byRoom = new Map();
  for (const r of rows) {
    if (!byRoom.has(r.room_number)) {
      byRoom.set(r.room_number, { roomNo: r.room_number, benches: r.benches, seating: new Map() });
    }
    const room = byRoom.get(r.room_number);
    if (!room.seating.has(r.bench_number)) {
      room.seating.set(r.bench_number, {
        row: Math.ceil(r.bench_number / 6),
        bench: r.bench_number,
        left: null,
        middle: null,
        right: null,
      });
    }
    const bench = room.seating.get(r.bench_number);
    bench[SEAT_KEY[r.seat_position]] = r.student_usn
      ? { name: r.name, usn: r.student_usn, semester: r.semester }
      : null;
  }
  return [...byRoom.values()].map((room) => ({
    roomNo: room.roomNo,
    benches: room.benches,
    seating: [...room.seating.values()].sort((a, b) => a.bench - b.bench),
  }));
}

// Rebuild the marked-attendance shape from attendance rows.
// A room's status is the furthest its rows reached (Finalized > Saved > Draft).
function buildAttendanceMarks(rows) {
  const byRoom = new Map();
  for (const r of rows) {
    if (!byRoom.has(r.room_number)) byRoom.set(r.room_number, []);
    byRoom.get(r.room_number).push(r);
  }
  const rank = { Draft: 0, Saved: 1, Finalized: 2 };
  return [...byRoom.entries()].map(([roomNo, rs]) => {
    const top = rs.reduce((a, b) => ((rank[b.record_status] || 0) > (rank[a.record_status] || 0) ? b : a), rs[0]);
    const savedAt = rs.reduce((m, r) => (r.marked_at && (!m || r.marked_at > m) ? r.marked_at : m), null);
    return {
      roomNo,
      status: toApiStatus(top.record_status),
      savedAt,
      students: rs.map((r) => ({
        usn: r.student_usn,
        name: r.name,
        semester: r.semester,
        present: r.attendance_status === "Present",
      })),
    };
  });
}

const EXAM_COLS = `exam_id, exam_name, to_char(exam_date, 'YYYY-MM-DD') AS date, session, created_at`;

// Full allocation detail, or null when the id is not a UUID or no such exam.
async function loadAllocation(examId) {
  if (!isUUID(examId)) return null;
  const { rows: exams } = await pool.query(
    `SELECT ${EXAM_COLS} FROM exam WHERE exam_id = $1`,
    [examId]
  );
  if (exams.length === 0) return null;
  const e = exams[0];
  const [{ rows: courseRows }, { rows: seatRows }, { rows: attRows }] = await Promise.all([
    pool.query(
      `SELECT m.course_id, m.semester, m.exam_name, c.course_name
       FROM exam_course_mapping m LEFT JOIN course c ON c.course_id = m.course_id
       WHERE m.exam_id = $1 ORDER BY m.semester, m.course_id`,
      [examId]
    ),
    pool.query(
      `SELECT sa.room_number, sa.bench_number, sa.seat_position, sa.student_usn,
              s.name, s.semester, r.number_of_benches AS benches
       FROM seating_allocation sa
       LEFT JOIN student s ON s.usn = sa.student_usn
       LEFT JOIN room r ON r.room_number = sa.room_number
       WHERE sa.exam_id = $1
       ORDER BY sa.room_number, sa.bench_number,
         CASE sa.seat_position WHEN 'Left' THEN 1 WHEN 'Middle' THEN 2 ELSE 3 END`,
      [examId]
    ),
    pool.query(
      `SELECT a.room_number, a.student_usn, a.attendance_status, a.record_status, a.marked_at,
              s.name, s.semester
       FROM attendance a LEFT JOIN student s ON s.usn = a.student_usn
       WHERE a.exam_id = $1 ORDER BY a.room_number, a.student_usn`,
      [examId]
    ),
  ]);
  const courses = courseRows.map((c) => ({
    courseName: c.course_name,
    courseCode: c.course_id,
    semester: c.semester,
    examName: c.exam_name,
  }));
  const rooms = buildRoomsFromRows(seatRows);
  return {
    exam_id: e.exam_id,
    examName: e.exam_name,
    date: e.date,
    session: e.session,
    createdAt: e.created_at,
    courses,
    rooms,
    summary: buildSummary(rooms),
    attendanceByRoom: buildAttendance(rooms),
    attendance: buildAttendanceMarks(attRows),
  };
}

// History list: one entry per exam with courses + derived summary.
// Seating for all listed exams loads in one query, not one per exam.
async function loadAllocationSummaries() {
  const { rows: exams } = await pool.query(
    `SELECT ${EXAM_COLS} FROM exam ORDER BY created_at DESC`
  );
  if (exams.length === 0) return [];
  const ids = exams.map((e) => e.exam_id);
  const [{ rows: courseRows }, { rows: seatRows }] = await Promise.all([
    pool.query(
      `SELECT m.exam_id, m.course_id, m.semester, m.exam_name, c.course_name
       FROM exam_course_mapping m LEFT JOIN course c ON c.course_id = m.course_id
       WHERE m.exam_id = ANY($1::uuid[]) ORDER BY m.semester, m.course_id`,
      [ids]
    ),
    pool.query(
      `SELECT sa.exam_id, sa.room_number, sa.bench_number, sa.seat_position, sa.student_usn,
              s.name, s.semester, r.number_of_benches AS benches
       FROM seating_allocation sa
       LEFT JOIN student s ON s.usn = sa.student_usn
       LEFT JOIN room r ON r.room_number = sa.room_number
       WHERE sa.exam_id = ANY($1::uuid[])
       ORDER BY sa.room_number, sa.bench_number,
         CASE sa.seat_position WHEN 'Left' THEN 1 WHEN 'Middle' THEN 2 ELSE 3 END`,
      [ids]
    ),
  ]);
  const coursesByExam = new Map();
  for (const c of courseRows) {
    if (!coursesByExam.has(c.exam_id)) coursesByExam.set(c.exam_id, []);
    coursesByExam.get(c.exam_id).push({
      courseName: c.course_name,
      courseCode: c.course_id,
      semester: c.semester,
      examName: c.exam_name,
    });
  }
  const seatsByExam = new Map();
  for (const s of seatRows) {
    if (!seatsByExam.has(s.exam_id)) seatsByExam.set(s.exam_id, []);
    seatsByExam.get(s.exam_id).push(s);
  }
  return exams.map((e) => ({
    exam_id: e.exam_id,
    examName: e.exam_name,
    date: e.date,
    session: e.session,
    createdAt: e.created_at,
    courses: coursesByExam.get(e.exam_id) || [],
    summary: buildSummary(buildRoomsFromRows(seatsByExam.get(e.exam_id) || [])),
  }));
}

// Delete an exam and everything under it. The tables have no ON DELETE
// CASCADE, so children go first. With a client, runs inside the caller's
// transaction; otherwise runs its own. Returns false for a bad id or when
// nothing was deleted.
async function deleteAllocation(examId, client) {
  if (!isUUID(examId)) return false;
  const run = async (c) => {
    await c.query("DELETE FROM attendance WHERE exam_id = $1", [examId]);
    await c.query("DELETE FROM seating_allocation WHERE exam_id = $1", [examId]);
    await c.query("DELETE FROM exam_course_mapping WHERE exam_id = $1", [examId]);
    const { rowCount } = await c.query("DELETE FROM exam WHERE exam_id = $1", [examId]);
    return rowCount > 0;
  };
  if (client) return run(client);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const deleted = await run(c);
    await c.query("COMMIT");
    return deleted;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

module.exports = {
  isUUID,
  buildRoomsFromRows,
  buildAttendanceMarks,
  loadAllocation,
  loadAllocationSummaries,
  deleteAllocation,
};
