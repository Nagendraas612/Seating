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

    // Recent allocations list (last 5)
    const recentList = document.getElementById("recent-list");
    if (!history || history.length === 0) {
      recentList.innerHTML =
        '<p class="empty-state">No allocations yet. Create your first one!</p>';
      return;
    }

    recentList.innerHTML = history
      .slice(0, 5)
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

    const groupedRows = {
      1: [],
      2: [],
      3: [],
    };

    room.seating.forEach((bench) => {

      groupedRows[bench.row].push(bench);
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
      const rows = room.students
        .map(
          (s, idx) => `
        <tr>
          <td>${idx + 1}</td>
          <td class="usn-code">${s.usn}</td>
          <td>${s.name}</td>
          <td>Sem ${s.semester}</td>
          <td style="border:1px solid var(--border-strong);min-width:100px;height:28px;"></td>
        </tr>`
        )
        .join("");

      return `
        <div class="room-block" style="margin-bottom:20px;">
          <div class="room-block-header">✍️ Attendance — Room: ${room.roomNo} (${room.students.length} students)</div>
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
    window.open(`${API}/api/pdf/notice/${allocId}`, "_blank");
  };
  document.getElementById("btn-seating-pdf").onclick = () => {
    window.open(`${API}/api/pdf/seating/${allocId}`, "_blank");
  };
  document.getElementById("btn-attendance-pdf").onclick = () => {
    window.open(`${API}/api/pdf/attendance/${allocId}`, "_blank");
  };
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
