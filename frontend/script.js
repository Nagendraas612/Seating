// ============================================================
// AIML Seat Allotment System — script.js
// Frontend Logic: Auth, Navigation, Rooms, Allocation, History
// ============================================================

// --- Backend base URL ---
// Change this if your backend runs on a different port/domain
const API = ""; // empty = same origin (works when backend serves frontend)

// --- Global state ---
let currentAllocationId = null; // ID of latest allocation (for PDF buttons)

// ============================================================
// ON PAGE LOAD — Check login status
// ============================================================

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch(`${API}/auth/status`, { credentials: "include" });
    const data = await res.json();

    if (data.loggedIn) {
      // Show app, hide login
      document.getElementById("login-section").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");

      // Fill user info in sidebar
      document.getElementById("user-name").textContent = data.user.name;
      document.getElementById("user-email").textContent = data.user.email;
      if (data.user.photo) {
        document.getElementById("user-photo").src = data.user.photo;
      }

      // Load dashboard data
      loadDashboard();
    } else {
      // Show login, hide app
      document.getElementById("login-section").classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
    }
  } catch (err) {
    console.error("Auth check failed:", err);
  }
});

// ============================================================
// NAVIGATION — Switch between pages
// ============================================================

// Attach click events to sidebar nav buttons
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const page = btn.dataset.page;
    showPage(page);
  });
});

function showPage(pageName) {
  // Hide all pages
  document.querySelectorAll(".page-content").forEach((p) =>
    p.classList.remove("active")
  );
  // Deactivate all nav items
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.remove("active")
  );

  // Show the target page
  const pageEl = document.getElementById(`page-${pageName}`);
  if (pageEl) pageEl.classList.add("active");

  // Activate corresponding nav button
  const navBtn = document.querySelector(`.nav-item[data-page="${pageName}"]`);
  if (navBtn) navBtn.classList.add("active");

  // Load data for the page
  if (pageName === "dashboard") loadDashboard();
  if (pageName === "rooms") loadRooms();
  if (pageName === "history") loadHistory();
  if (pageName === "attendance") loadAttendancePage();
  if (pageName === "reports") loadReportsPage();
}

// ============================================================
// DASHBOARD
// ============================================================

async function loadDashboard() {
  try {
    // Fetch rooms and history in parallel
    const [roomsRes, historyRes] = await Promise.all([
      fetch(`${API}/api/rooms`, { credentials: "include" }),
      fetch(`${API}/api/history`, { credentials: "include" }),
    ]);

    const rooms = await roomsRes.json();
    const history = await historyRes.json();

    // Update stat cards
    document.getElementById("stat-rooms").textContent = rooms.length || 0;
    document.getElementById("stat-enabled").textContent =
      rooms.filter((r) => r.enabled).length || 0;
    document.getElementById("stat-allocs").textContent = history.length || 0;

    // Recent allocations list (last 2)
    const recentList = document.getElementById("recent-list");
    if (!history || history.length === 0) {
      recentList.innerHTML =
        '<p class="empty-state">No allocations yet. Create your first one!</p>';
      return;
    }

    recentList.innerHTML = history
      .slice(0, 2)
      .map(
        (h) => `
      <div class="recent-item" onclick="viewHistoryAlloc('${h._id}')">
        <div>
          <div class="recent-item-name">${h.examName}</div>
          <div class="recent-item-meta">${h.date} · ${h.session}</div>
        </div>
        <span class="recent-item-badge">${h.summary.length} rooms</span>
      </div>`
      )
      .join("");
  } catch (err) {
    console.error("Dashboard load error:", err);
  }
}

// ============================================================
// ROOM MANAGEMENT
// ============================================================

async function loadRooms() {
  try {
    const res = await fetch(`${API}/api/rooms`, { credentials: "include" });
    const rooms = await res.json();

    const tbody = document.getElementById("rooms-tbody");

    if (!rooms || rooms.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty-cell">No rooms added yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rooms
      .map(
        (room) => `
      <tr>
        <td><strong>${room.roomNo}</strong></td>
        <td>${room.benches}</td>
        <td>${room.benches * 3}</td>
        <td>
          <span class="${room.enabled ? "badge-enabled" : "badge-disabled"}">
            ${room.enabled ? "Enabled" : "Disabled"}
          </span>
        </td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-edit" onclick="openEditModal('${room._id}','${room.roomNo}',${room.benches},${room.enabled})">Edit</button>
          <button class="btn-toggle ${room.enabled ? "" : "disabled"}" onclick="toggleRoom('${room._id}', ${room.enabled}, '${room.roomNo}', ${room.benches})">
            ${room.enabled ? "Disable" : "Enable"}
          </button>
          <button class="btn-danger" onclick="deleteRoom('${room._id}')">Delete</button>
        </td>
      </tr>`
      )
      .join("");
  } catch (err) {
    console.error("Load rooms error:", err);
  }
}

// Add a new room
async function addRoom() {
  const roomNo = document.getElementById("newRoomNo").value.trim();
  const benches = document.getElementById("newRoomBenches").value.trim();

  if (!roomNo || !benches) {
    alert("Please enter both Room Number and Number of Benches.");
    return;
  }

  try {
    const res = await fetch(`${API}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ roomNo, benches: Number(benches), enabled: true }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Clear inputs
    document.getElementById("newRoomNo").value = "";
    document.getElementById("newRoomBenches").value = "";

    // Refresh table
    loadRooms();
  } catch (err) {
    alert("Error adding room: " + err.message);
  }
}

// Open the edit modal
function openEditModal(id, roomNo, benches, enabled) {
  document.getElementById("edit-room-id").value = id;
  document.getElementById("edit-room-no").value = roomNo;
  document.getElementById("edit-room-benches").value = benches;
  document.getElementById("edit-room-enabled").value = String(enabled);
  document.getElementById("edit-modal").classList.remove("hidden");
}

// Close the edit modal
function closeModal() {
  document.getElementById("edit-modal").classList.add("hidden");
}

// Save edited room
async function saveRoom() {
  const id = document.getElementById("edit-room-id").value;
  const roomNo = document.getElementById("edit-room-no").value.trim();
  const benches = document.getElementById("edit-room-benches").value;
  const enabled = document.getElementById("edit-room-enabled").value === "true";

  try {
    const res = await fetch(`${API}/api/rooms/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ roomNo, benches: Number(benches), enabled }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeModal();
    loadRooms();
  } catch (err) {
    alert("Error saving room: " + err.message);
  }
}

// Quick toggle enable/disable
async function toggleRoom(id, currentEnabled, roomNo, benches) {
  try {
    await fetch(`${API}/api/rooms/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        roomNo,
        benches: Number(benches),
        enabled: !currentEnabled,
      }),
    });
    loadRooms();
  } catch (err) {
    alert("Error toggling room: " + err.message);
  }
}

// Delete a room
async function deleteRoom(id) {
  if (!confirm("Are you sure you want to delete this room?")) return;
  try {
    await fetch(`${API}/api/rooms/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    loadRooms();
  } catch (err) {
    alert("Error deleting room: " + err.message);
  }
}

// ============================================================
// FILE UPLOAD HANDLING & COURSE ENTRIES
// ============================================================

let courseEntryCount = 1; // Start with 1 entry already in HTML

function addCourseEntry() {
  const container = document.getElementById("course-entries");
  const idx = courseEntryCount++;

  const entry = document.createElement("div");
  entry.className = "course-entry";
  entry.dataset.index = idx;
  entry.innerHTML = `
    <div class="course-entry-header">
      <span>Course ${idx + 1}</span>
      <button type="button" class="btn-remove-course" onclick="removeCourseEntry(this)">✕</button>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Course Name</label>
        <input type="text" class="course-name" placeholder="e.g. DBMS" required />
      </div>
      <div class="form-group">
        <label>Course Code</label>
        <input type="text" class="course-code" placeholder="e.g. 22CS42" required />
      </div>
      <div class="form-group">
        <label>Semester</label>
        <select class="course-semester" required>
          <option value="">Select...</option>
          <option value="I">I</option>
          <option value="II">II</option>
          <option value="III">III</option>
          <option value="IV">IV</option>
          <option value="V">V</option>
          <option value="VI">VI</option>
          <option value="VII">VII</option>
          <option value="VIII">VIII</option>
        </select>
      </div>
    </div>
    <div class="file-drop-zone course-drop-zone">
      <div class="drop-icon">📂</div>
      <p>Upload student file (Excel/CSV)</p>
      <input type="file" class="course-file" accept=".xlsx,.xls,.csv" required />
    </div>
    <div class="course-file-list file-list"></div>
  `;
  container.appendChild(entry);
}

function removeCourseEntry(btn) {
  const entry = btn.closest(".course-entry");
  entry.remove();
}

// Show file name when a course file is selected
document.addEventListener("change", (e) => {
  if (e.target.classList.contains("course-file")) {
    const entry = e.target.closest(".course-entry");
    const fileList = entry.querySelector(".course-file-list");
    fileList.innerHTML = "";
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      const chip = document.createElement("div");
      chip.className = "file-chip";
      chip.innerHTML = `📄 ${file.name} <span>${(file.size / 1024).toFixed(1)} KB</span>`;
      fileList.appendChild(chip);
    }
  }
});

// ============================================================
// ALLOCATION SUBMISSION
// ============================================================

async function submitAllocation(event) {
  event.preventDefault();

  const examName = document.getElementById("examName").value.trim();
  const date = document.getElementById("examDate").value;
  const session = document.getElementById("examSession").value;

  // Gather course entries
  const courseEntries = document.querySelectorAll(".course-entry");
  if (courseEntries.length === 0) {
    alert("Please add at least one course entry.");
    return;
  }

  // Validate all entries have files
  for (const entry of courseEntries) {
    const fileInput = entry.querySelector(".course-file");
    if (!fileInput.files.length) {
      alert("Please upload a student file for each course entry.");
      return;
    }
  }

  // Show loading
  document.getElementById("loading").classList.remove("hidden");
  document.getElementById("allocate-btn").disabled = true;
  document.getElementById("output-section").classList.add("hidden");

  try {
    // Build FormData
    const formData = new FormData();
    formData.append("examName", examName);
    formData.append("date", date);
    formData.append("session", session);

    courseEntries.forEach((entry, idx) => {
      const courseName = entry.querySelector(".course-name").value.trim();
      const courseCode = entry.querySelector(".course-code").value.trim();
      const semester = entry.querySelector(".course-semester").value;
      const fileInput = entry.querySelector(".course-file");

      formData.append(`courses[${idx}][courseName]`, courseName);
      formData.append(`courses[${idx}][courseCode]`, courseCode);
      formData.append(`courses[${idx}][semester]`, semester);
      formData.append(`course_file_${idx}`, fileInput.files[0]);
    });

    const res = await fetch(`${API}/api/allocate`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Save allocation ID for PDF downloads
    currentAllocationId = data.allocationId;

    // Display results
    displayAllocationOutput(data, examName, date, session);
  } catch (err) {
    alert("Allocation failed: " + err.message);
  } finally {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("allocate-btn").disabled = false;
  }
}

// ============================================================
// DISPLAY ALLOCATION RESULTS
// ============================================================

function displayAllocationOutput(data, examName, date, session) {
  const section = document.getElementById("output-section");
  section.classList.remove("hidden");

  document.getElementById("output-exam-label").textContent =
    `${examName} · ${date} · ${session}`;

  // Set PDF download URLs
  setupPdfButtons(currentAllocationId);

  // Render each tab
  renderNoticeBoard(data.summary);
  renderSeatingLayout(data.rooms);
  renderAttendance(data.attendanceByRoom);

  // Activate first tab
  switchTab("notice");

  // Scroll to output
  section.scrollIntoView({ behavior: "smooth" });
}

// ---- Notice Board Tab ----
function renderNoticeBoard(summary) {
  const container = document.getElementById("notice-table-container");
  if (!summary || summary.length === 0) {
    container.innerHTML = '<p class="empty-state">No data.</p>';
    return;
  }

  container.innerHTML = `
    <div class="table-card">
      <table class="data-table">
        <thead>
          <tr>
            <th>Room No</th>
            <th>Semesters</th>
            <th>USN Ranges</th>
            <th>Student Count</th>
          </tr>
        </thead>
        <tbody>
          ${summary
            .map(
              (r) => `
            <tr>
              <td><strong>${r.roomNo}</strong></td>
              <td>${r.semesters.join(", ")}</td>
              <td>${r.usnRanges.join("<br/>")}</td>
              <td><strong>${r.studentCount}</strong></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

// ---- Seating Layout Tab ----

function renderSeatingLayout(rooms) {
  console.log(document.getElementById("seating-container"));

const container = document.getElementById("seating-container");
  container.innerHTML = "";

  rooms.forEach((room) => {

    // =====================================================
    // GROUP BENCHES BY ROW
    // =====================================================

    const groupedRows = {};

    room.seating.forEach((bench) => {
      const row = bench.row || 1;
      if (!groupedRows[row]) groupedRows[row] = [];
      groupedRows[row].push(bench);
    });

    // =====================================================
    // ROOM BLOCK
    // =====================================================

    const roomHTML = `
      <div class="room-block">

        <div class="room-block-header">
          🏫 Room ${room.roomNo}
        </div>

        <div class="room-layout">

          ${Object.keys(groupedRows)
            .map((rowNum) => {

              const benches = groupedRows[rowNum];

              return `
                <div class="room-row">

                  <div class="row-title">
                    ROW-${rowNum}
                  </div>

                  <table class="data-table seating-table">

                    <thead>
                      <tr>
                        <th>Bench</th>
                        <th>LEFT</th>
                        <th>MIDDLE</th>
                        <th>RIGHT</th>
                      </tr>
                    </thead>

                    <tbody>

                      ${benches
                        .map((bench) => {

                          const renderSeat = (s) => {

                            if (!s) {
                              return `
                                <div class="seat-empty">
                                  —
                                </div>
                              `;
                            }

                            return `
                              <div class="seat-cell">

                                <div class="${
                                  s.semester === "IV"
                                    ? "seat-a"
                                    : "seat-b"
                                }">

                                  ${s.usn}

                                </div>

                                <div>
                                  ${s.name}
                                </div>

                                <div class="usn-code">
                                  (${s.semester})
                                </div>

                              </div>
                            `;
                          };

                          return `
                            <tr>

                              <td>
                                Bench-${bench.bench}
                              </td>

                              <td>
                                ${renderSeat(bench.left)}
                              </td>

                              <td>
                                ${renderSeat(bench.middle)}
                              </td>

                              <td>
                                ${renderSeat(bench.right)}
                              </td>

                            </tr>
                          `;
                        })
                        .join("")}

                    </tbody>

                  </table>

                </div>
              `;
            })
            .join("")}

        </div>

      </div>
    `;

    container.innerHTML += roomHTML;
  });
}

// Format a single seat (student object or null)
function formatSeatCell(student) {
  if (!student) return '<span class="seat-empty">— empty —</span>';
  // Colour by semester (alternates A/B based on position)
  return `
    <div class="usn-code">${student.usn}</div>
    <div>${student.name}</div>
    <div style="font-size:11px;color:var(--text-muted);">Sem ${student.semester}</div>`;
}

// ---- Attendance Tab ----
function renderAttendance(attendanceByRoom) {
  const container = document.getElementById("attendance-container");
  if (!attendanceByRoom || attendanceByRoom.length === 0) {
    container.innerHTML = '<p class="empty-state">No data.</p>';
    return;
  }

  container.innerHTML = attendanceByRoom
    .map((room) => {
      // Group students by semester within this room
      const semGroups = {};
      for (const s of room.students) {
        const sem = s.semester || "Unknown";
        if (!semGroups[sem]) semGroups[sem] = [];
        semGroups[sem].push(s);
      }

      const semSections = Object.keys(semGroups)
        .sort()
        .map((sem) => {
          const students = semGroups[sem];
          const rows = students
            .map(
              (s, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td class="usn-code">${s.usn}</td>
              <td>${s.name}</td>
              <td>Sem ${sem}</td>
              <td style="border:1px solid var(--border-strong);min-width:100px;height:28px;"></td>
            </tr>`
            )
            .join("");

          return `
            <div class="attendance-sem-section">
              <div class="attendance-sem-label">Semester ${sem} (${students.length} students)</div>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>S.No</th>
                    <th>USN</th>
                    <th>Name</th>
                    <th>Semester</th>
                    <th>Signature</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`;
        })
        .join("");

      return `
        <div class="room-block" style="margin-bottom:24px;">
          <div class="room-block-header">✍️ Attendance — Room: ${room.roomNo} (${room.students.length} students)</div>
          ${semSections}
        </div>`;
    })
    .join("");
}

// ============================================================
// OUTPUT TABS
// ============================================================

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
  });
});

function switchTab(tabName) {
  // Deactivate all tabs
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.remove("active")
  );
  document.querySelectorAll(".tab-content").forEach((c) =>
    c.classList.remove("active")
  );

  // Activate target tab
  document
    .querySelector(`.tab-btn[data-tab="${tabName}"]`)
    ?.classList.add("active");
  document.getElementById(`tab-${tabName}`)?.classList.add("active");
}

// ============================================================
// PDF DOWNLOAD BUTTONS
// ============================================================

function setupPdfButtons(allocId) {
  document.getElementById("btn-notice-pdf").onclick = () => {
    openPdfPreview(`${API}/api/pdf/notice/${allocId}`, "Notice Board PDF");
  };
  document.getElementById("btn-seating-pdf").onclick = () => {
    openPdfPreview(`${API}/api/pdf/seating/${allocId}`, "Seating Layout PDF");
  };
  document.getElementById("btn-attendance-pdf").onclick = () => {
    openPdfPreview(`${API}/api/pdf/attendance/${allocId}`, "Attendance Sheet PDF");
  };
}

// ============================================================
// PDF PREVIEW MODAL
// ============================================================

function openPdfPreview(url, title) {
  document.getElementById("pdf-preview-title").textContent = title || "PDF Preview";
  document.getElementById("pdf-preview-iframe").src = url;
  document.getElementById("pdf-preview-modal").classList.remove("hidden");
}

function closePdfPreview(event) {
  if (event && event.target !== event.currentTarget) return; // Only close on overlay click
  document.getElementById("pdf-preview-modal").classList.add("hidden");
  document.getElementById("pdf-preview-iframe").src = "";
}

// ============================================================
// HISTORY PAGE
// ============================================================

async function loadHistory() {
  try {
    const res = await fetch(`${API}/api/history`, { credentials: "include" });
    const history = await res.json();

    const container = document.getElementById("history-list");

    if (!history || history.length === 0) {
      container.innerHTML = '<p class="empty-state">No history found.</p>';
      return;
    }

    container.innerHTML = history
      .map(
        (h) => `
      <div class="history-card">
        <h4>${h.examName}</h4>
        <div class="meta">📅 ${h.date} &nbsp;·&nbsp; ${h.session}</div>
        <div class="meta">📁 ${new Date(h.createdAt).toLocaleString()}</div>
        <div class="rooms-count">🏫 ${h.summary.length} room(s) &nbsp;|&nbsp; ${h.summary.reduce((s, r) => s + r.studentCount, 0)} students</div>
        <div class="history-pdf-btns">
          <a href="${API}/api/pdf/notice/${h._id}" target="_blank">📋 Notice</a>
          <a href="${API}/api/pdf/seating/${h._id}" target="_blank">🪑 Seating</a>
          <a href="${API}/api/pdf/attendance/${h._id}" target="_blank">✍️ Attendance</a>
        </div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.error("History load error:", err);
  }
}

// View an allocation from history (navigate to output section)
async function viewHistoryAlloc(id) {
  try {
    const res = await fetch(`${API}/api/history/${id}`, {
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentAllocationId = id;

    showPage("create");

    displayAllocationOutput(
      {
        summary: data.summary,
        rooms: data.rooms,
        attendanceByRoom: data.attendanceByRoom,
        allocationId: id,
      },
      data.examName,
      data.date,
      data.session
    );
  } catch (err) {
    alert("Could not load allocation: " + err.message);
  }
}

// ============================================================
// ATTENDANCE FEATURE
// ============================================================

// State for attendance marking
let currentAttendanceExam = null;   // { _id, examName, date, session, attendanceByRoom, courses }
let currentAttendanceRoom = null;   // { roomNo, students: [...] }
let attendanceState = {};           // { usn: true/false } — true = present, false = absent

// ---- Sidebar dropdown toggle ----
function toggleAttendanceDropdown() {
  const dropdown = document.getElementById("attendance-dropdown");
  const arrow = document.getElementById("attendance-arrow");
  const isHidden = dropdown.classList.contains("hidden");

  if (isHidden) {
    dropdown.classList.remove("hidden");
    arrow.classList.add("open");
    loadAttendanceExamList();
  } else {
    dropdown.classList.add("hidden");
    arrow.classList.remove("open");
  }
}

// Load exam list into the sidebar dropdown
async function loadAttendanceExamList() {
  const listEl = document.getElementById("attendance-exam-list");
  listEl.innerHTML = '<div class="nav-sub-loading">Loading...</div>';

  try {
    const res = await fetch(`${API}/api/history`, { credentials: "include" });
    const history = await res.json();

    if (!history || history.length === 0) {
      listEl.innerHTML = '<div class="nav-sub-loading">No exams found.</div>';
      return;
    }

    listEl.innerHTML = history
      .map(
        (h) => `
        <button class="nav-sub-item" onclick="openAttendanceForExam('${h._id}')">
          ${h.examName}<br/>
          <span style="font-size:11px;opacity:.6;">${h.date} · ${h.session}</span>
        </button>`
      )
      .join("");
  } catch (err) {
    listEl.innerHTML = '<div class="nav-sub-loading">Error loading.</div>';
    console.error("Attendance exam list error:", err);
  }
}

// Open the rooms list for a specific exam
async function openAttendanceForExam(examId) {
  // Highlight active item
  document.querySelectorAll(".nav-sub-item").forEach((b) => b.classList.remove("active"));
  const btn = document.querySelector(`.nav-sub-item[onclick="openAttendanceForExam('${examId}')"]`);
  if (btn) btn.classList.add("active");

  try {
    const res = await fetch(`${API}/api/history/${examId}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentAttendanceExam = data;

    // Show the rooms page
    showAttendancePage("attendance-rooms");

    // Fill header
    document.getElementById("att-exam-title").textContent =
      `Attendance — ${data.examName}`;
    document.getElementById("att-exam-meta").textContent =
      `${data.date} · ${data.session}`;

    // Render room cards
    renderAttendanceRooms(data);
  } catch (err) {
    alert("Could not load exam: " + err.message);
  }
}

// Render room cards for the attendance rooms page
function renderAttendanceRooms(data) {
  const grid = document.getElementById("att-rooms-grid");

  if (!data.attendanceByRoom || data.attendanceByRoom.length === 0) {
    grid.innerHTML = '<p class="empty-state">No rooms found for this exam.</p>';
    return;
  }

  grid.innerHTML = data.attendanceByRoom
    .map((room) => {
      // Collect unique semesters in this room
      const sems = [...new Set(room.students.map((s) => s.semester))].sort();
      return `
        <div class="att-room-card" onclick="openAttendanceMarking('${room.roomNo}')">
          <div class="room-no">🏫 ${room.roomNo}</div>
          <div class="room-sems">Sem: ${sems.join(", ")}</div>
          <div class="room-count">${room.students.length} students</div>
        </div>`;
    })
    .join("");
}

// Open the marking page for a specific room
function openAttendanceMarking(roomNo) {
  if (!currentAttendanceExam) return;

  const roomData = currentAttendanceExam.attendanceByRoom.find(
    (r) => r.roomNo === roomNo
  );
  if (!roomData) return;

  currentAttendanceRoom = roomData;

  // Initialize all students as present (checked)
  attendanceState = {};
  for (const s of roomData.students) {
    attendanceState[s.usn] = true; // true = present
  }

  showAttendancePage("attendance-mark");

  // Fill header
  document.getElementById("mark-room-title").textContent =
    `Mark Attendance — Room ${roomNo}`;
  document.getElementById("mark-room-meta").textContent =
    `${currentAttendanceExam.examName} · ${currentAttendanceExam.date} · ${currentAttendanceExam.session}`;

  // Course info cards
  renderMarkCourseInfo();

  // Student list
  renderMarkStudentList();
}

// Render course/batch info cards at top of marking page
function renderMarkCourseInfo() {
  const container = document.getElementById("mark-course-info");
  const courses = currentAttendanceExam.courses || [];

  if (courses.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = courses
    .map(
      (c) => `
      <div class="course-info-card">
        <div class="ci-label">Course</div>
        <div class="ci-value">${c.courseName || "—"}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${c.courseCode || ""} · Sem ${c.semester || "—"}</div>
      </div>`
    )
    .join("");
}

/**
 * Determine the academic year from semester:
 * Sem I, II → 1st Year
 * Sem III, IV → 2nd Year
 * Sem V, VI → 3rd Year
 * Sem VII, VIII → 4th Year
 */
function semToYear(sem) {
  const semOrder = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
  const n = semOrder[sem] || 99;
  if (n <= 2) return { year: 1, label: "1st Year" };
  if (n <= 4) return { year: 2, label: "2nd Year" };
  if (n <= 6) return { year: 3, label: "3rd Year" };
  return { year: 4, label: "4th Year" };
}

// Render the student list grouped by year, sorted by USN within each group
function renderMarkStudentList() {
  const container = document.getElementById("mark-student-list");
  const students = currentAttendanceRoom.students;

  if (!students || students.length === 0) {
    container.innerHTML = '<p class="empty-state">No students in this room.</p>';
    return;
  }

  // Group by year
  const yearGroups = {};
  for (const s of students) {
    const { year, label } = semToYear(s.semester);
    if (!yearGroups[year]) yearGroups[year] = { label, students: [] };
    yearGroups[year].students.push(s);
  }

  // Sort each group by USN
  for (const y of Object.keys(yearGroups)) {
    yearGroups[y].students.sort((a, b) => a.usn.localeCompare(b.usn));
  }

  // Build summary bar
  const total = students.length;
  const absentCount = Object.values(attendanceState).filter((v) => !v).length;
  const presentCount = total - absentCount;

  let html = `
    <div class="att-summary-bar" id="att-summary-bar">
      <div class="sum-item"><div class="sum-dot present"></div><strong>${presentCount}</strong> Present</div>
      <div class="sum-item"><div class="sum-dot absent"></div><strong>${absentCount}</strong> Absent</div>
      <div class="sum-item" style="color:var(--text-muted);">Total: ${total}</div>
    </div>`;

  // Render each year group
  let globalIdx = 1;
  for (const year of Object.keys(yearGroups).sort()) {
    const group = yearGroups[year];
    html += `
      <div class="att-year-section">
        <div class="att-year-header">
          ${group.label}
          <span class="year-badge">${group.students.length} students</span>
        </div>
        <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm);">`;

    for (const s of group.students) {
      const isPresent = attendanceState[s.usn] !== false;
      html += `
        <div class="att-student-row${isPresent ? "" : " absent"}" id="row-${s.usn.replace(/[^a-zA-Z0-9]/g, "_")}">
          <span class="att-sno">${globalIdx++}</span>
          <input type="checkbox" class="att-checkbox"
            ${isPresent ? "checked" : ""}
            onchange="toggleAttendance('${s.usn}', this.checked)"
            title="${isPresent ? "Present" : "Absent"}"
          />
          <span class="att-usn">${s.usn}</span>
          <span class="att-name">${s.name}</span>
          <span class="att-sem-badge">Sem ${s.semester}</span>
          <span class="att-status-label ${isPresent ? "present" : "absent"}" id="status-${s.usn.replace(/[^a-zA-Z0-9]/g, "_")}">
            ${isPresent ? "Present" : "Absent"}
          </span>
        </div>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
}

// Toggle a student's attendance
function toggleAttendance(usn, isPresent) {
  attendanceState[usn] = isPresent;

  // Update row styling
  const safeId = usn.replace(/[^a-zA-Z0-9]/g, "_");
  const row = document.getElementById(`row-${safeId}`);
  const statusEl = document.getElementById(`status-${safeId}`);

  if (row) {
    row.classList.toggle("absent", !isPresent);
  }
  if (statusEl) {
    statusEl.textContent = isPresent ? "Present" : "Absent";
    statusEl.className = `att-status-label ${isPresent ? "present" : "absent"}`;
  }

  // Update summary bar
  updateSummaryBar();
}

function updateSummaryBar() {
  const total = currentAttendanceRoom.students.length;
  const absentCount = Object.values(attendanceState).filter((v) => !v).length;
  const presentCount = total - absentCount;

  const bar = document.getElementById("att-summary-bar");
  if (bar) {
    bar.innerHTML = `
      <div class="sum-item"><div class="sum-dot present"></div><strong>${presentCount}</strong> Present</div>
      <div class="sum-item"><div class="sum-dot absent"></div><strong>${absentCount}</strong> Absent</div>
      <div class="sum-item" style="color:var(--text-muted);">Total: ${total}</div>`;
  }
}

function markAllPresent() {
  for (const usn of Object.keys(attendanceState)) {
    attendanceState[usn] = true;
  }
  renderMarkStudentList();
}

function markAllAbsent() {
  for (const usn of Object.keys(attendanceState)) {
    attendanceState[usn] = false;
  }
  renderMarkStudentList();
}

// Go back to the rooms list
function goBackToRooms() {
  showAttendancePage("attendance-rooms");
}

// Show an attendance sub-page (hides all other pages)
function showAttendancePage(pageName) {
  document.querySelectorAll(".page-content").forEach((p) =>
    p.classList.remove("active")
  );
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.remove("active")
  );

  const pageEl = document.getElementById(`page-${pageName}`);
  if (pageEl) pageEl.classList.add("active");

  // Keep attendance nav button highlighted
  document.getElementById("attendance-nav-btn").classList.add("active");
}

// ---- Download Absent Students PDF ----
async function downloadAbsentPdf() {
  if (!currentAttendanceRoom || !currentAttendanceExam) return;

  // Collect absent students
  const absentStudents = currentAttendanceRoom.students.filter(
    (s) => attendanceState[s.usn] === false
  );

  if (absentStudents.length === 0) {
    alert("No absent students to report. All students are marked present.");
    return;
  }

  const btn = document.getElementById("btn-save-absent-pdf");
  btn.disabled = true;
  btn.textContent = "Generating PDF...";

  try {
    const payload = {
      examName: currentAttendanceExam.examName,
      date: currentAttendanceExam.date,
      session: currentAttendanceExam.session,
      roomNo: currentAttendanceRoom.roomNo,
      courses: currentAttendanceExam.courses || [],
      absentStudents,
    };

    const res = await fetch(`${API}/api/attendance/absent-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "PDF generation failed");
    }

    // Download the PDF blob
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `absent_${currentAttendanceExam.examName}_Room${currentAttendanceRoom.roomNo}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Error generating PDF: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "📄 Download Absent List PDF";
  }
}


// ============================================================
// ATTENDANCE PAGE
// ============================================================

let attSelectedAllocId = null;
let attSelectedRoomNo = null;
let attStudentData = []; // Current room's students with attendance state

async function loadAttendancePage() {
  // Show exam select, hide others
  document.getElementById("att-exam-select").classList.remove("hidden");
  document.getElementById("att-room-select").classList.add("hidden");
  document.getElementById("att-mark-section").classList.add("hidden");

  try {
    const res = await fetch(`${API}/api/history`, { credentials: "include" });
    const history = await res.json();
    const grid = document.getElementById("att-exam-grid");

    if (!history || history.length === 0) {
      grid.innerHTML = '<p class="empty-state">No allocations found. Create one first.</p>';
      return;
    }

    grid.innerHTML = history
      .map(
        (h) => `
      <div class="history-card" onclick="attSelectExam('${h._id}', '${h.examName}', '${h.date}', '${h.session}')" style="cursor:pointer;">
        <h4>${h.examName}</h4>
        <div class="meta">📅 ${h.date} · ${h.session}</div>
        <div class="rooms-count">🏫 ${h.summary ? h.summary.length : 0} room(s)</div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.error("Attendance page load error:", err);
  }
}

async function attSelectExam(allocId, examName, date, session) {
  attSelectedAllocId = allocId;

  document.getElementById("att-exam-select").classList.add("hidden");
  document.getElementById("att-room-select").classList.remove("hidden");
  document.getElementById("att-mark-section").classList.add("hidden");
  document.getElementById("att-selected-exam-title").textContent = `${examName} — ${date} (${session})`;

  try {
    const res = await fetch(`${API}/api/history/${allocId}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const grid = document.getElementById("att-room-grid");
    if (!data.attendanceByRoom || data.attendanceByRoom.length === 0) {
      grid.innerHTML = '<p class="empty-state">No rooms found.</p>';
      return;
    }

    grid.innerHTML = data.attendanceByRoom
      .map(
        (room) => `
      <div class="att-room-card" onclick="attSelectRoom('${allocId}', '${room.roomNo}')">
        <div class="att-room-icon">🏫</div>
        <div class="att-room-name">${room.roomNo}</div>
        <div class="att-room-count">${room.students.length} students</div>
      </div>`
      )
      .join("");
  } catch (err) {
    alert("Error loading exam: " + err.message);
  }
}

async function attSelectRoom(allocId, roomNo) {
  attSelectedRoomNo = roomNo;

  document.getElementById("att-room-select").classList.add("hidden");
  document.getElementById("att-mark-section").classList.remove("hidden");
  document.getElementById("att-room-title").textContent = `Room: ${roomNo}`;

  try {
    const res = await fetch(`${API}/api/history/${allocId}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const room = data.attendanceByRoom.find((r) => r.roomNo === roomNo);
    if (!room) {
      document.getElementById("att-student-list").innerHTML = '<p class="empty-state">Room not found.</p>';
      return;
    }

    // Check if attendance was already saved
    const savedAttendance = data.attendance || [];
    const savedRoom = savedAttendance.find((a) => a.roomNo === roomNo);

    // Build student list with attendance state
    attStudentData = room.students.map((s) => {
      const saved = savedRoom ? savedRoom.students.find((ss) => ss.usn === s.usn) : null;
      return {
        ...s,
        present: saved ? saved.present : true, // Default: present
      };
    });

    renderAttendanceMarking();
  } catch (err) {
    alert("Error loading room: " + err.message);
  }
}

function renderAttendanceMarking() {
  // Group by semester
  const semGroups = {};
  for (const s of attStudentData) {
    const sem = s.semester || "Unknown";
    if (!semGroups[sem]) semGroups[sem] = [];
    semGroups[sem].push(s);
  }

  const container = document.getElementById("att-student-list");
  container.innerHTML = Object.keys(semGroups)
    .sort()
    .map((sem) => {
      const students = semGroups[sem];
      const presentCount = students.filter((s) => s.present).length;
      const rows = students
        .map(
          (s, idx) => `
        <tr class="${s.present ? "" : "absent-row"}">
          <td>${idx + 1}</td>
          <td class="usn-code">${s.usn}</td>
          <td>${s.name}</td>
          <td>
            <label class="att-toggle">
              <input type="checkbox" ${s.present ? "checked" : ""} onchange="attToggleStudent('${s.usn}', this.checked)" />
              <span class="att-toggle-label ${s.present ? "present" : "absent"}">${s.present ? "P" : "A"}</span>
            </label>
          </td>
        </tr>`
        )
        .join("");

      return `
        <div class="attendance-sem-section">
          <div class="attendance-sem-label">Semester ${sem} — ${presentCount}/${students.length} Present</div>
          <table class="data-table">
            <thead>
              <tr><th>S.No</th><th>USN</th><th>Name</th><th>Status</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join("");
}

function attToggleStudent(usn, isPresent) {
  const student = attStudentData.find((s) => s.usn === usn);
  if (student) student.present = isPresent;
  renderAttendanceMarking();
}

function attMarkAllPresent() {
  attStudentData.forEach((s) => (s.present = true));
  renderAttendanceMarking();
}

function attMarkAllAbsent() {
  attStudentData.forEach((s) => (s.present = false));
  renderAttendanceMarking();
}

async function attSaveAttendance() {
  if (!attSelectedAllocId || !attSelectedRoomNo) return;

  try {
    const res = await fetch(`${API}/api/attendance/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        allocationId: attSelectedAllocId,
        roomNo: attSelectedRoomNo,
        students: attStudentData.map((s) => ({
          usn: s.usn,
          name: s.name,
          semester: s.semester,
          present: s.present,
        })),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    alert("Attendance saved successfully!");
  } catch (err) {
    alert("Error saving attendance: " + err.message);
  }
}

function attBackToExams() {
  document.getElementById("att-exam-select").classList.remove("hidden");
  document.getElementById("att-room-select").classList.add("hidden");
  document.getElementById("att-mark-section").classList.add("hidden");
}

function attBackToRooms() {
  document.getElementById("att-room-select").classList.remove("hidden");
  document.getElementById("att-mark-section").classList.add("hidden");
}


// ============================================================
// REPORTS PAGE
// ============================================================

let rptSelectedAllocId = null;
let rptAllocData = null;

async function loadReportsPage() {
  document.getElementById("rpt-exam-select").classList.remove("hidden");
  document.getElementById("rpt-view").classList.add("hidden");

  try {
    const res = await fetch(`${API}/api/history`, { credentials: "include" });
    const history = await res.json();
    const grid = document.getElementById("rpt-exam-grid");

    if (!history || history.length === 0) {
      grid.innerHTML = '<p class="empty-state">No allocations found.</p>';
      return;
    }

    // Only show exams that have attendance saved
    grid.innerHTML = history
      .map(
        (h) => `
      <div class="history-card" onclick="rptSelectExam('${h._id}')" style="cursor:pointer;">
        <h4>${h.examName}</h4>
        <div class="meta">📅 ${h.date} · ${h.session}</div>
        <div class="rooms-count">🏫 ${h.summary ? h.summary.length : 0} room(s)</div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.error("Reports page load error:", err);
  }
}

async function rptSelectExam(allocId) {
  rptSelectedAllocId = allocId;

  try {
    const res = await fetch(`${API}/api/history/${allocId}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    rptAllocData = data;

    document.getElementById("rpt-exam-select").classList.add("hidden");
    document.getElementById("rpt-view").classList.remove("hidden");
    document.getElementById("rpt-exam-title").textContent = `${data.examName} — ${data.date} (${data.session})`;

    // Check if attendance exists
    if (!data.attendance || data.attendance.length === 0) {
      document.getElementById("rpt-tab-course").innerHTML =
        '<p class="empty-state">No attendance has been marked for this exam yet. Go to Attendance page to mark it first.</p>';
      document.getElementById("rpt-tab-room").innerHTML =
        '<p class="empty-state">No attendance data available.</p>';
      return;
    }

    renderCourseWiseReport(data);
    renderRoomWiseReport(data);
    rptSwitchTab("course");
  } catch (err) {
    alert("Error loading report: " + err.message);
  }
}

function renderCourseWiseReport(data) {
  const container = document.getElementById("rpt-tab-course");
  const attendance = data.attendance || [];
  const courses = data.courses || [];

  if (courses.length === 0) {
    // Old allocation without courses — group by semester
    const allStudents = [];
    for (const room of attendance) {
      for (const s of room.students) {
        allStudents.push({ ...s, roomNo: room.roomNo });
      }
    }

    const semGroups = {};
    for (const s of allStudents) {
      const sem = s.semester || "Unknown";
      if (!semGroups[sem]) semGroups[sem] = { present: [], absent: [] };
      if (s.present) semGroups[sem].present.push(s);
      else semGroups[sem].absent.push(s);
    }

    container.innerHTML = Object.keys(semGroups)
      .sort()
      .map((sem) => {
        const g = semGroups[sem];
        const total = g.present.length + g.absent.length;
        const absentRows = g.absent
          .map((s, i) => `<tr><td>${i + 1}</td><td class="usn-code">${s.usn}</td><td>${s.name}</td><td>${s.roomNo}</td></tr>`)
          .join("");

        return `
          <div class="rpt-course-card">
            <div class="rpt-course-header">
              <div>
                <strong>Semester ${sem}</strong>
              </div>
              <div class="rpt-stats">
                <span class="rpt-stat present">✓ ${g.present.length} Present</span>
                <span class="rpt-stat absent">✗ ${g.absent.length} Absent</span>
                <span class="rpt-stat total">Total: ${total}</span>
              </div>
            </div>
            ${g.absent.length > 0 ? `
              <div class="rpt-absent-list">
                <table class="data-table">
                  <thead><tr><th>S.No</th><th>USN</th><th>Name</th><th>Room</th></tr></thead>
                  <tbody>${absentRows}</tbody>
                </table>
              </div>` : '<p style="padding:0.5rem;color:var(--success);font-size:0.9rem;">All students present ✓</p>'}
          </div>`;
      })
      .join("");
    return;
  }

  // Group attendance by course (using semester from courses)
  const courseReports = courses.map((course) => {
    const sem = course.semester;
    const studentsInCourse = [];

    for (const room of attendance) {
      for (const s of room.students) {
        if (s.semester === sem) {
          studentsInCourse.push({ ...s, roomNo: room.roomNo });
        }
      }
    }

    const present = studentsInCourse.filter((s) => s.present);
    const absent = studentsInCourse.filter((s) => !s.present);

    return { course, present, absent, total: studentsInCourse.length };
  });

  container.innerHTML = courseReports
    .map((r) => {
      const absentRows = r.absent
        .map((s, i) => `<tr><td>${i + 1}</td><td class="usn-code">${s.usn}</td><td>${s.name}</td><td>${s.roomNo}</td></tr>`)
        .join("");

      return `
        <div class="rpt-course-card">
          <div class="rpt-course-header">
            <div>
              <strong>${r.course.courseName}</strong> (${r.course.courseCode})
              <span style="color:var(--text-secondary);font-size:0.85rem;"> — Sem ${r.course.semester}</span>
            </div>
            <div class="rpt-stats">
              <span class="rpt-stat present">✓ ${r.present.length} Present</span>
              <span class="rpt-stat absent">✗ ${r.absent.length} Absent</span>
              <span class="rpt-stat total">Total: ${r.total}</span>
              <button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="openPdfPreview('${API}/api/pdf/absent-report/${rptSelectedAllocId}/course/${courses.indexOf(r.course)}', '${r.course.courseName} — Absent Report')">📄 PDF</button>
            </div>
          </div>
          ${r.absent.length > 0 ? `
            <div class="rpt-absent-list">
              <table class="data-table">
                <thead><tr><th>S.No</th><th>USN</th><th>Name</th><th>Room</th></tr></thead>
                <tbody>${absentRows}</tbody>
              </table>
            </div>` : '<p style="padding:0.5rem;color:var(--success);font-size:0.9rem;">All students present ✓</p>'}
        </div>`;
    })
    .join("");
}

function renderRoomWiseReport(data) {
  const container = document.getElementById("rpt-tab-room");
  const attendance = data.attendance || [];

  if (attendance.length === 0) {
    container.innerHTML = '<p class="empty-state">No attendance data.</p>';
    return;
  }

  container.innerHTML = attendance
    .map((room) => {
      const present = room.students.filter((s) => s.present);
      const absent = room.students.filter((s) => !s.present);

      // Group absent by semester
      const absentBySem = {};
      for (const s of absent) {
        const sem = s.semester || "Unknown";
        if (!absentBySem[sem]) absentBySem[sem] = [];
        absentBySem[sem].push(s);
      }

      const absentSections = Object.keys(absentBySem)
        .sort()
        .map((sem) => {
          const students = absentBySem[sem];
          const rows = students
            .map((s, i) => `<tr><td>${i + 1}</td><td class="usn-code">${s.usn}</td><td>${s.name}</td></tr>`)
            .join("");
          return `
            <div style="margin-top:0.5rem;">
              <div class="attendance-sem-label">Sem ${sem} — ${students.length} absent</div>
              <table class="data-table"><thead><tr><th>S.No</th><th>USN</th><th>Name</th></tr></thead><tbody>${rows}</tbody></table>
            </div>`;
        })
        .join("");

      return `
        <div class="rpt-course-card">
          <div class="rpt-course-header">
            <div><strong>Room: ${room.roomNo}</strong></div>
            <div class="rpt-stats">
              <span class="rpt-stat present">✓ ${present.length}</span>
              <span class="rpt-stat absent">✗ ${absent.length}</span>
              <span class="rpt-stat total">Total: ${room.students.length}</span>
              <button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="openPdfPreview('${API}/api/pdf/absent-report/${rptSelectedAllocId}/room/${room.roomNo}', 'Room ${room.roomNo} — Absent Report')">📄 PDF</button>
            </div>
          </div>
          ${absent.length > 0 ? absentSections : '<p style="padding:0.5rem;color:var(--success);font-size:0.9rem;">All present ✓</p>'}
        </div>`;
    })
    .join("");
}

function rptSwitchTab(tab) {
  document.querySelectorAll("#rpt-view .tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".rpt-tab-content").forEach((c) => c.classList.add("hidden"));

  if (tab === "course") {
    document.querySelector('#rpt-view .tab-btn:first-child').classList.add("active");
    document.getElementById("rpt-tab-course").classList.remove("hidden");
  } else {
    document.querySelector('#rpt-view .tab-btn:last-child').classList.add("active");
    document.getElementById("rpt-tab-room").classList.remove("hidden");
  }
}

function rptBackToExams() {
  document.getElementById("rpt-exam-select").classList.remove("hidden");
  document.getElementById("rpt-view").classList.add("hidden");
}

function rptDownloadPdf() {
  if (!rptSelectedAllocId) return;
  openPdfPreview(`${API}/api/pdf/absent-report/${rptSelectedAllocId}`, "Absent Report PDF");
}
