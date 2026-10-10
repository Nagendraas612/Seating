// Refactored module (pure move from server.js): seating algorithm + summary/attendance builders

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
    // Keep original file order — no sorting by USN
    batches[sem] = [...semesterStudents[sem]];
  }

  const semKeys = Object.keys(batches);
  const queues = {};
  for (const sem of semKeys) queues[sem] = 0;

  // =========================================================
  // STEP 2 — HELPERS
  // =========================================================

  function remaining(sem) {
    if (!sem) return 0;
    return batches[sem].length - queues[sem];
  }

  function hasStudentsLeft() {
    return semKeys.some((sem) => remaining(sem) > 0);
  }

  function getNextStudent(sem) {
    if (!sem || queues[sem] >= batches[sem].length) return null;
    const student = batches[sem][queues[sem]++];
    const displaySem = (groupToSemester && groupToSemester[sem]) || sem;
    return { ...student, semester: displaySem };
  }

  // Get active groups (those with remaining students), sorted by initial count (descending)
  function getActiveGroups() {
    return semKeys
      .filter((sem) => remaining(sem) > 0)
      .sort((a, b) => batches[b].length - batches[a].length); // Sort by INITIAL count for stable identity
  }

  // =========================================================
  // STEP 3 — DETERMINE INITIAL MODE & GLOBAL IDENTITY
  //
  // A = most students (initial), B = second, C = third (if exists)
  // Identity is locked at start and never changes.
  // =========================================================

  const sortedByCount = [...semKeys].sort((a, b) => batches[b].length - batches[a].length);
  const globalSemA = sortedByCount[0] || null; // Most students
  const globalSemB = sortedByCount[1] || null; // Second most
  const globalSemC = sortedByCount[2] || null; // Third (may be null)

  const totalGroups = sortedByCount.filter(s => batches[s].length > 0).length;

  console.log(`📐 Seating mode: ${totalGroups} groups | A=${globalSemA}(${remaining(globalSemA)}) B=${globalSemB ? globalSemB + '(' + remaining(globalSemB) + ')' : 'none'} C=${globalSemC ? globalSemC + '(' + remaining(globalSemC) + ')' : 'none'}`);

  // =========================================================
  // STEP 4 — BENCH-BY-BENCH ALLOCATION WITH DYNAMIC FALLBACK
  //
  // 3 groups: ABC ABC ABC (every bench: Left=A, Middle=B, Right=C)
  // 2 groups: ABA BAB ABA (row alternation + room alternation)
  // 1 group:  A_A A_A (Left=A, Middle=empty, Right=A)
  //
  // When a group runs out mid-allocation, immediately switch mode.
  // =========================================================

  const ROWS_PER_ROOM = 3;
  const BENCHES_PER_ROW = 6;
  const finalRooms = [];

  // Counter for rooms that run entirely (or start) in 2-group mode.
  // Even = room starts ABA, Odd = room starts BAB.
  // A room that transitions FROM 3-group mid-way does NOT count —
  // only rooms where row 0 itself runs in 2-group mode increment this.
  let twoGroupRoomCount = 0;

  for (let roomIdx = 0; roomIdx < rooms.length; roomIdx++) {

    if (!hasStudentsLeft()) break;

    const room = rooms[roomIdx];
    const roomResult = {
      roomNo: room.roomNo,
      benches: room.benches,
      seating: [],
    };

    // Determine this room's 2-group starting pattern BEFORE the row loop.
    // Check if row 0 of this room will run in 2-group mode by peeking at
    // the current active group count (queues haven't moved yet).
    // Even twoGroupRoomCount = starts ABA, Odd = starts BAB.
    const roomStartsABA = twoGroupRoomCount % 2 === 0;
    let roomCountedForTwoGroup = false;

    for (let row = 0; row < ROWS_PER_ROOM; row++) {

      if (!hasStudentsLeft()) break;

      // Determine current mode based on how many groups still have students
      const activeGroups = getActiveGroups();
      const currentMode = activeGroups.length;

      if (currentMode >= 3) {        // ---- 3-GROUP MODE: ABC ABC (no alternation) ----
        // Always: Left=A, Middle=B, Right=C
        const leftCol = [];
        const middleCol = [];
        const rightCol = [];

        for (let b = 0; b < BENCHES_PER_ROW; b++) {
          leftCol.push(getNextStudent(globalSemA));
          middleCol.push(getNextStudent(globalSemB));
          rightCol.push(getNextStudent(globalSemC));
        }

        for (let b = 0; b < BENCHES_PER_ROW; b++) {
          const benchNum = row * BENCHES_PER_ROW + b + 1;
          const benchData = {
            row: row + 1,
            bench: benchNum,
            left: leftCol[b],
            middle: middleCol[b],
            right: rightCol[b],
          };
          if (benchData.left || benchData.middle || benchData.right) {
            roomResult.seating.push(benchData);
          }
        }

      } else if (currentMode === 2) {
        // ---- 2-GROUP MODE: ABA BAB (with alternation) ----
        // Use the GLOBAL identity order so A/B labels never flip mid-allocation.
        const globalOrder = [globalSemA, globalSemB, globalSemC].filter(
          (s) => s && remaining(s) > 0
        );
        const semA2 = globalOrder[0]; // Globally-ranked A (or B if A exhausted)
        const semB2 = globalOrder[1]; // Globally-ranked B (or C if B exhausted)

        // rowIsABA: uses the room-level roomStartsABA (computed once before
        // the row loop) so all rows in this room share the same base pattern.
        // Row 0 = room's base pattern, row 1 = flipped, row 2 = base again.
        const rowIsABA = roomStartsABA ? (row % 2 === 0) : (row % 2 !== 0);

        // Count this room once for the alternation counter,
        // but ONLY if row 0 itself ran in 2-group mode.
        // Transition rooms (row 0 was 3-group) don't shift the alternation.
        if (!roomCountedForTwoGroup && row === 0) {
          twoGroupRoomCount++;
          roomCountedForTwoGroup = true;
        }

        const colSems = rowIsABA
          ? [semA2, semB2, semA2]
          : [semB2, semA2, semB2];

        const leftCol = [];
        const middleCol = [];
        const rightCol = [];

        // Fill each column fully before moving to the next.
        // This ensures left column = seats 1-6 of the column's batch,
        // middle = seats 1-6 of the middle batch,
        // right = seats 7-12 of the column's batch (continuing the queue).
        // If left and right share the same batch (ABA: left=A, right=A),
        // filling left first then right gives A1-A6 on left, A7-A12 on right.
        for (let b = 0; b < BENCHES_PER_ROW; b++) leftCol.push(getNextStudent(colSems[0]));
        for (let b = 0; b < BENCHES_PER_ROW; b++) middleCol.push(getNextStudent(colSems[1]));
        for (let b = 0; b < BENCHES_PER_ROW; b++) rightCol.push(getNextStudent(colSems[2]));

        for (let b = 0; b < BENCHES_PER_ROW; b++) {
          const benchNum = row * BENCHES_PER_ROW + b + 1;
          const benchData = {
            row: row + 1,
            bench: benchNum,
            left: leftCol[b],
            middle: middleCol[b],
            right: rightCol[b],
          };
          if (benchData.left || benchData.middle || benchData.right) {
            roomResult.seating.push(benchData);
          }
        }

      } else if (currentMode === 1) {
        // ---- 1-GROUP MODE: A_A (Left=A, Middle=empty, Right=A) ----
        const lastSem = activeGroups[0];
        const leftCol = [];
        const rightCol = [];

        // Fill left column fully first, then right column,
        // so bench-1 gets A1 on left and A7 on right (not A1/A2 interleaved).
        for (let b = 0; b < BENCHES_PER_ROW; b++) leftCol.push(getNextStudent(lastSem));
        for (let b = 0; b < BENCHES_PER_ROW; b++) rightCol.push(getNextStudent(lastSem));

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

module.exports = {
  extractBatchFromUSN,
  groupStudentsByBatch,
  allocateSeats,
  buildSummary,
  buildAttendance,
};
