// ============================================================
// AIML Seat Allotment System — script.js
// Frontend Logic: Auth, Navigation, Rooms, Allocation, History
// ============================================================

// --- Backend base URL ---
// Change this if your backend runs on a different port/domain
const API = ""; // empty = same origin (works when backend serves frontend)

// --- Global state ---
let currentAllocationId = null; // ID of latest allocation (for PDF buttons)
let editingAllocationId = null; // (zip-merged) Set when editing/re-generating an existing allocation

// --- CSRF token (#17) ---
// Fetched once on load from /api/csrf-token, then echoed in X-CSRF-Token
// header on every state-changing call. Combined with sameSite=lax cookies
// this gives defense-in-depth against CSRF.
let csrfToken = null;

async function fetchCsrfToken() {
  try {
    const r = await fetch(`${API}/api/csrf-token`, { credentials: "include" });
    if (!r.ok) return;
    const data = await r.json();
    csrfToken = data.csrfToken || null;
  } catch (err) {
    console.error("CSRF token fetch failed:", err);
  }
}

// Drop-in fetch wrapper that injects credentials + CSRF header on writes.
async function apiFetch(url, options = {}) {
  const opts = { credentials: "include", ...options };
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) await fetchCsrfToken();
    opts.headers = { ...(opts.headers || {}), "X-CSRF-Token": csrfToken || "" };
  }
  return fetch(url, opts);
}

// ============================================================
// HTML ESCAPING (#10)
// All user-controlled values are funneled through escapeHtml() before being
// inserted via innerHTML. Stops stored XSS via room numbers, exam names,
// student names, etc.
// ============================================================

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`/]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
    "/": "&#47;",
  })[ch]);
}

// Convenience: escape inside attribute strings (same set; left as alias for clarity at call sites).
const esc = escapeHtml;

// Render a one-line summary of an allocation's courses (subject names + sems).
// Used on every exam-card grid (History, Attendance, Reports) so faculty
// can identify exams without opening them.
function formatCourseSummary(courses) {
  if (!Array.isArray(courses) || courses.length === 0) return "";
  const parts = courses.map((c) => {
    const name = (c && c.courseName) || "";
    const code = (c && c.courseCode) || "";
    const sem = (c && c.semester) || "";
    const head = name ? `${esc(name)}${code ? ` (${esc(code)})` : ""}` : esc(code);
    return sem ? `${head} — Sem ${esc(sem)}` : head;
  });
  return parts.join(", ");
}

// Render the unique semesters across an allocation's courses.
function formatSemesters(courses) {
  if (!Array.isArray(courses) || courses.length === 0) return "";
  const sems = [...new Set(courses.map((c) => c && c.semester).filter(Boolean))];
  return sems.length ? `Sem ${sems.map(esc).join(" & ")}` : "";
}

// ============================================================
// PWA INSTALL — beforeinstallprompt (Android/Chrome) + iOS hint
// ============================================================

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  // Stop Chrome from showing its mini-infobar; we'll show our own button.
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById("btn-install");
  if (btn) btn.classList.remove("hidden");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById("btn-install");
  if (btn) btn.classList.add("hidden");
  const hint = document.getElementById("ios-install-hint");
  if (hint) hint.classList.add("hidden");
});

async function installPwa() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try {
    await deferredInstallPrompt.userChoice;
  } finally {
    deferredInstallPrompt = null;
    const btn = document.getElementById("btn-install");
    if (btn) btn.classList.add("hidden");
  }
}
window.installPwa = installPwa;

function isIos() {
  // iOS detection — covers iPhone, iPad (incl. iPadOS reporting as Mac)
  const ua = navigator.userAgent || "";
  const iosUA = /iPhone|iPad|iPod/.test(ua);
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iosUA || iPadOS;
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

// On iOS show the manual "Add to Home Screen" hint, since beforeinstallprompt
// is not supported there. Also hide everything once the app is already installed.
window.addEventListener("DOMContentLoaded", () => {
  if (isStandalone()) return;
  if (isIos()) {
    const hint = document.getElementById("ios-install-hint");
    if (hint) hint.classList.remove("hidden");
  }
});

// (zip-merged) Wire static buttons that exist in index.html on first paint.
window.addEventListener("DOMContentLoaded", () => {
  const editBtn = document.getElementById("btn-edit-allocation");
  if (editBtn && editBtn.dataset.wired !== "1") {
    editBtn.addEventListener("click", editCurrentAllocation);
    editBtn.dataset.wired = "1";
  }

  // Mobile bottom-nav buttons mirror the sidebar nav. Wire them by data-page.
  document.querySelectorAll(".mob-nav-item[data-page]").forEach((btn) => {
    if (btn.dataset.wired === "1") return;
    btn.addEventListener("click", () => {
      const page = btn.getAttribute("data-page");
      if (page) showPage(page);
      // Update the active style on the bottom-nav siblings.
      document.querySelectorAll(".mob-nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
    btn.dataset.wired = "1";
  });
});

// Register the service worker (required for installability + offline shell).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

// (#16) Logout via POST + CSRF — replaces the old GET <a href>.
// Exposed on window so the inline onclick="logoutUser()" can find it.
async function logoutUser() {
  try {
    await apiFetch(`${API}/auth/logout`, { method: "POST" });
  } catch (err) {
    console.error("Logout failed:", err);
  } finally {
    window.location.href = "/";
  }
}
window.logoutUser = logoutUser;

// ============================================================
// ZIP-MERGED FEATURES — Edit allocation, Delete allocation,
// Attendance status flow (draft / saved / finalized)
// ============================================================

// Switch the create form into "edit" mode for the currently-displayed
// allocation. submitAllocation() picks up editingAllocationId and sends
// replaceId so the server deletes the old record before saving the new.
function editCurrentAllocation() {
  if (!currentAllocationId) return;
  editingAllocationId = currentAllocationId;
  document.getElementById("output-section").classList.add("hidden");
  const form = document.getElementById("create-form");
  if (form) form.scrollIntoView({ behavior: "smooth" });
  const btn = document.getElementById("allocate-btn");
  if (btn) btn.textContent = "🔄 Re-generate Seating Arrangement";
}
window.editCurrentAllocation = editCurrentAllocation;

// Delete an allocation from history (CSRF-protected via apiFetch).
async function deleteAllocation(id) {
  if (!confirm("Are you sure you want to remove this allocation? This cannot be undone.")) return;
  try {
    const res = await apiFetch(`${API}/api/history/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Delete failed");
    // Refresh whichever views might be visible
    if (typeof loadHistory === "function") loadHistory();
    if (typeof loadDashboard === "function") loadDashboard();
  } catch (err) {
    alert("Error deleting allocation: " + err.message);
  }
}
window.deleteAllocation = deleteAllocation;

// Confirm + finalize the current room. attSaveAttendance("finalized") locks it.
function attFinalizeAttendance() {
  if (!confirm("Are you sure you want to finalize this room's attendance?\n\nOnce finalized, it CANNOT be changed.")) return;
  attSaveAttendance("finalized");
}
window.attFinalizeAttendance = attFinalizeAttendance;

// Update the per-semester present/total counts in the marking page header
// without re-rendering the entire table — keeps checkbox state intact.
function updateAttendanceCounts() {
  const semGroups = {};
  for (const s of attStudentData) {
    const sem = s.semester || "Unknown";
    if (!semGroups[sem]) semGroups[sem] = { total: 0, present: 0 };
    semGroups[sem].total++;
    if (s.present) semGroups[sem].present++;
  }
  document.querySelectorAll(".attendance-sem-label[data-sem]").forEach((label) => {
    const sem = label.dataset.sem;
    if (semGroups[sem]) {
      label.textContent = `Semester ${sem} — ${semGroups[sem].present}/${semGroups[sem].total} Present`;
    }
  });
}

// ============================================================
// SKELETON LOADING — Reusable skeleton renderer
// ============================================================

/**
 * Show skeleton loading animation in a container.
 * @param {string} containerId - The ID of the container element
 * @param {string} type - Type of skeleton: 'stats', 'table', 'cards', 'list'
 */
function showSkeleton(containerId, type) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let html = '';

  switch (type) {
    case 'stats':
      html = `<div class="skeleton-stats-grid">
        ${Array(3).fill('').map(() => `
          <div class="skeleton-stat-card">
            <div class="skeleton-icon"></div>
            <div class="skeleton-value"></div>
            <div class="skeleton-label"></div>
          </div>`).join('')}
      </div>`;
      break;

    case 'table':
      html = `<div class="table-card">
        <div style="padding:0;">
          <div class="skeleton-table-row" style="background:#f8fafc;">
            <div class="skeleton-table-cell"></div>
            <div class="skeleton-table-cell"></div>
            <div class="skeleton-table-cell"></div>
            <div class="skeleton-table-cell"></div>
            <div class="skeleton-table-cell"></div>
          </div>
          ${Array(5).fill('').map(() => `
            <div class="skeleton-table-row">
              <div class="skeleton-table-cell"></div>
              <div class="skeleton-table-cell"></div>
              <div class="skeleton-table-cell"></div>
              <div class="skeleton-table-cell"></div>
              <div class="skeleton-table-cell"></div>
            </div>`).join('')}
        </div>
      </div>`;
      break;

    case 'cards':
      html = `<div class="skeleton-cards-grid">
        ${Array(4).fill('').map(() => `
          <div class="skeleton-card">
            <div class="skeleton-card-title"></div>
            <div class="skeleton-card-meta"></div>
            <div class="skeleton-card-meta" style="width:35%"></div>
            <div class="skeleton-card-footer"></div>
          </div>`).join('')}
      </div>`;
      break;

    case 'list':
      html = Array(4).fill('').map(() => `
        <div class="skeleton-list-item">
          <div class="skeleton-list-icon"></div>
          <div class="skeleton-list-text">
            <div class="skeleton-list-title"></div>
            <div class="skeleton-list-sub"></div>
          </div>
        </div>`).join('');
      break;

    default:
      html = `<div class="skeleton-container">
        <div class="skeleton-header"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row short"></div>
        <div class="skeleton-row"></div>
      </div>`;
  }

  container.innerHTML = html;
}

// ============================================================
// ON PAGE LOAD — Check login status
// ============================================================

window.addEventListener("DOMContentLoaded", async () => {
  // Always fetch a CSRF token first, even when logged out, so the login page works.
  await fetchCsrfToken();
  try {
    const res = await fetch(`${API}/auth/status`, { credentials: "include" });
    const data = await res.json();

    if (data.loggedIn) {
      // Show app, hide login
      document.getElementById("login-section").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");

      // Fill user info in sidebar — use textContent to neutralize XSS (#10)
      document.getElementById("user-name").textContent = data.user.name || "";
      document.getElementById("user-email").textContent = data.user.email || "";
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

  // (zip-merged) Keep the mobile bottom-nav in sync with the active page.
  document.querySelectorAll(".mob-nav-item").forEach((b) => b.classList.remove("active"));
  const mobBtn = document.querySelector(`.mob-nav-item[data-page="${pageName}"]`);
  if (mobBtn) mobBtn.classList.add("active");

  // Close mobile menu if open
  const sidebar = document.querySelector(".sidebar");
  if (sidebar && sidebar.classList.contains("open")) {
    toggleMobileMenu();
  }

  // Load data for the page
  if (pageName === "dashboard") loadDashboard();
  if (pageName === "rooms") loadRooms();
  if (pageName === "history") loadHistory();
  if (pageName === "attendance") loadAttendancePage();
  if (pageName === "reports") loadReportsPage();
}

// Mobile menu toggle
function toggleMobileMenu() {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.getElementById("mobile-overlay");
  sidebar.classList.toggle("open");
  overlay.classList.toggle("hidden");
}

// ============================================================
// DASHBOARD
// ============================================================

async function loadDashboard() {
  // Show skeleton loading for stats
  showSkeleton("stats-grid", "stats");

  try {
    // Fetch rooms and history in parallel
    const [roomsRes, historyRes] = await Promise.all([
      fetch(`${API}/api/rooms`, { credentials: "include" }),
      fetch(`${API}/api/history`, { credentials: "include" }),
    ]);

    const rooms = await roomsRes.json();
    const history = await historyRes.json();

    // Restore stat cards
    document.getElementById("stats-grid").innerHTML = `
      <div class="stat-card">
        <div class="stat-icon">▣</div>
        <div class="stat-value" id="stat-rooms">${rooms.length || 0}</div>
        <div class="stat-label">Total Rooms</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">⬡</div>
        <div class="stat-value" id="stat-enabled">${rooms.filter((r) => r.enabled).length || 0}</div>
        <div class="stat-label">Enabled Rooms</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">◷</div>
        <div class="stat-value" id="stat-allocs">${history.length || 0}</div>
        <div class="stat-label">Past Allocations</div>
      </div>
    `;

    // Recent allocations list (last 2)
    const recentList = document.getElementById("recent-list");
    if (!history || history.length === 0) {
      recentList.innerHTML =
        '<p class="empty-state">No allocations yet. Create your first one!</p>';
      return;
    }

    recentList.innerHTML = history
      .slice(0, 2)
      .map((h) => {
        const semLine = formatSemesters(h.courses);
        return `
      <div class="recent-item" onclick="viewHistoryAlloc('${esc(h._id)}')">
        <div>
          <div class="recent-item-name">${esc(h.examName)}${semLine ? ` <span style="font-size:11px;color:var(--text-muted);font-weight:500;">· ${semLine}</span>` : ""}</div>
          <div class="recent-item-meta">${esc(h.date)} · ${esc(h.session)}</div>
        </div>
        <span class="recent-item-badge">${h.summary.length} rooms</span>
      </div>`;
      })
      .join("");
  } catch (err) {
    console.error("Dashboard load error:", err);
  }
}

// ============================================================
// ROOM MANAGEMENT
// ============================================================

async function loadRooms() {
  // Show skeleton loading for table
  const tbody = document.getElementById("rooms-tbody");
  tbody.innerHTML = `
    <tr><td colspan="5" style="padding:0;border:none;">
      <div class="skeleton-table-row"><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div></div>
      <div class="skeleton-table-row"><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div></div>
      <div class="skeleton-table-row"><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div></div>
      <div class="skeleton-table-row"><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div><div class="skeleton-table-cell"></div></div>
    </td></tr>`;

  try {
    const res = await fetch(`${API}/api/rooms`, { credentials: "include" });
    const rooms = await res.json();

    if (!rooms || rooms.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty-cell">No rooms added yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rooms
      .map(
        (room) => `
      <tr>
        <td><strong>${esc(room.roomNo)}</strong></td>
        <td>${Number(room.benches) || 0}</td>
        <td>${(Number(room.benches) || 0) * 3}</td>
        <td>
          <span class="${room.enabled ? "badge-enabled" : "badge-disabled"}">
            ${room.enabled ? "Enabled" : "Disabled"}
          </span>
        </td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-edit" onclick="openEditModal('${esc(room._id)}','${esc(room.roomNo)}',${Number(room.benches) || 0},${!!room.enabled})">Edit</button>
          <button class="btn-toggle ${room.enabled ? "" : "disabled"}" onclick="toggleRoom('${esc(room._id)}', ${!!room.enabled}, '${esc(room.roomNo)}', ${Number(room.benches) || 0})">
            ${room.enabled ? "Disable" : "Enable"}
          </button>
          <button class="btn-danger" onclick="deleteRoom('${esc(room._id)}')">Delete</button>
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
    const res = await apiFetch(`${API}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const res = await apiFetch(`${API}/api/rooms/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
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
    await apiFetch(`${API}/api/rooms/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
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
    await apiFetch(`${API}/api/rooms/${id}`, {
      method: "DELETE",
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

    // (zip-merged) If we're editing an existing allocation, server will
    // delete the old one before saving the new one.
    if (editingAllocationId) {
      formData.append("replaceId", editingAllocationId);
    }

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

    const res = await apiFetch(`${API}/api/allocate`, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Save allocation ID for PDF downloads, clear edit mode
    currentAllocationId = data.allocationId;
    editingAllocationId = null;
    // Reset the button label in case we were in edit mode
    const allocBtn = document.getElementById("allocate-btn");
    if (allocBtn) allocBtn.textContent = "🎯 Generate Seating Arrangement";

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
              <td><strong>${esc(r.roomNo)}</strong></td>
              <td>${r.semesters.map(esc).join(", ")}</td>
              <td>${r.usnRanges.map(esc).join("<br/>")}</td>
              <td><strong>${Number(r.studentCount) || 0}</strong></td>
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
          🏫 Room ${esc(room.roomNo)}
        </div>

        <div class="room-layout">

          ${Object.keys(groupedRows)
            .map((rowNum) => {

              const benches = groupedRows[rowNum];

              return `
                <div class="room-row">

                  <div class="row-title">
                    ROW-${esc(rowNum)}
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

                                  ${esc(s.usn)}

                                </div>

                                <div>
                                  ${esc(s.name)}
                                </div>

                                <div class="usn-code">
                                  (${esc(s.semester)})
                                </div>

                              </div>
                            `;
                          };

                          return `
                            <tr>

                              <td>
                                Bench-${Number(bench.bench) || 0}
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
    <div class="usn-code">${esc(student.usn)}</div>
    <div>${esc(student.name)}</div>
    <div style="font-size:11px;color:var(--text-muted);">Sem ${esc(student.semester)}</div>`;
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
              <td class="usn-code">${esc(s.usn)}</td>
              <td>${esc(s.name)}</td>
              <td>Sem ${esc(sem)}</td>
              <td style="border:1px solid var(--border-strong);min-width:100px;height:28px;"></td>
            </tr>`
            )
            .join("");

          return `
            <div class="attendance-sem-section">
              <div class="attendance-sem-label">Semester ${esc(sem)} (${students.length} students)</div>
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
          <div class="room-block-header">✍️ Attendance — Room: ${esc(room.roomNo)} (${room.students.length} students)</div>
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
  // Show skeleton loading for history cards
  const container = document.getElementById("history-list");
  showSkeleton("history-list", "cards");

  try {
    const res = await fetch(`${API}/api/history`, { credentials: "include" });
    const history = await res.json();

    if (!history || history.length === 0) {
      container.innerHTML = '<p class="empty-state">No history found.</p>';
      return;
    }

    container.innerHTML = history
      .map(
        (h) => {
          // (zip-merged) Show course names + per-course absent PDF buttons
          // and a Remove button on each history card.
          const courseLine = formatCourseSummary(h.courses);
          const semLine = formatSemesters(h.courses);

          let absentButtons = "";
          if (h.courses && h.courses.length > 0) {
            absentButtons = h.courses
              .map((c, idx) =>
                `<a href="${API}/api/pdf/absent-report/${encodeURIComponent(h._id)}/course/${idx}" target="_blank" class="btn-pdf-small">📄 ${esc(c.courseName)}</a>`
              )
              .join("");
          } else {
            absentButtons = `<a href="${API}/api/pdf/absent-report/${encodeURIComponent(h._id)}" target="_blank" class="btn-pdf-small">📄 Absentees Report</a>`;
          }

          return `
      <div class="history-card">
        <h4>${esc(h.examName)}${semLine ? ` <span style="font-size:12px;color:var(--text-muted);font-weight:500;">· ${semLine}</span>` : ""}</h4>
        <div class="meta">📅 ${esc(h.date)} &nbsp;·&nbsp; ${esc(h.session)}</div>
        <div class="meta">📁 ${esc(new Date(h.createdAt).toLocaleString())}</div>
        ${courseLine ? `<div class="meta">📚 ${courseLine}</div>` : ""}
        <div class="rooms-count">🏫 ${h.summary.length} room(s) &nbsp;|&nbsp; ${h.summary.reduce((s, r) => s + (Number(r.studentCount) || 0), 0)} students</div>
        <div class="history-pdf-btns" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
          <a href="${API}/api/pdf/notice/${encodeURIComponent(h._id)}" target="_blank" class="btn-pdf-small">📋 Notice</a>
          <a href="${API}/api/pdf/seating/${encodeURIComponent(h._id)}" target="_blank" class="btn-pdf-small">🪑 Seating</a>
          <a href="${API}/api/pdf/attendance/${encodeURIComponent(h._id)}" target="_blank" class="btn-pdf-small">✍️ Attendance</a>
          ${absentButtons}
          <button class="btn-delete-history" data-alloc-id="${esc(h._id)}">🗑 Remove</button>
        </div>
      </div>`;
        }
      )
      .join("");

    // Wire delete buttons via addEventListener so CSP can't break them.
    container.querySelectorAll(".btn-delete-history").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-alloc-id");
        if (id) deleteAllocation(id);
      });
    });
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
        <button class="nav-sub-item" onclick="openAttendanceForExam('${esc(h._id)}')">
          ${esc(h.examName)}<br/>
          <span style="font-size:11px;opacity:.6;">${esc(h.date)} · ${esc(h.session)}</span>
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

    // Fill header — textContent neutralizes XSS (#10)
    document.getElementById("att-exam-title").textContent =
      `Attendance — ${data.examName || ""}`;
    document.getElementById("att-exam-meta").textContent =
      `${data.date || ""} · ${data.session || ""}`;

    // Render room cards
    renderAttendanceRooms(data);
  } catch (err) {
    alert("Could not load exam: " + err.message);
  }
}

// Render room cards 
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
        <div class="att-room-card" onclick="openAttendanceMarking('${esc(room.roomNo)}')">
          <div class="room-no">🏫 ${esc(room.roomNo)}</div>
          <div class="room-sems">Sem: ${sems.map(esc).join(", ")}</div>
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

  // Fill header — textContent prevents XSS (#10)
  document.getElementById("mark-room-title").textContent =
    `Mark Attendance — Room ${roomNo}`;
  document.getElementById("mark-room-meta").textContent =
    `${currentAttendanceExam.examName || ""} · ${currentAttendanceExam.date || ""} · ${currentAttendanceExam.session || ""}`;

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
        <div class="ci-value">${esc(c.courseName) || "—"}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${esc(c.courseCode) || ""} · Sem ${esc(c.semester) || "—"}</div>
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
        <div class="att-student-row${isPresent ? "" : " absent"}" id="row-${esc(s.usn).replace(/[^a-zA-Z0-9]/g, "_")}">
          <span class="att-sno">${globalIdx++}</span>
          <input type="checkbox" class="att-checkbox"
            ${isPresent ? "checked" : ""}
            onchange="toggleAttendance('${esc(s.usn)}', this.checked)"
            title="${isPresent ? "Present" : "Absent"}"
          />
          <span class="att-usn">${esc(s.usn)}</span>
          <span class="att-name">${esc(s.name)}</span>
          <span class="att-sem-badge">Sem ${esc(s.semester)}</span>
          <span class="att-status-label ${isPresent ? "present" : "absent"}" id="status-${esc(s.usn).replace(/[^a-zA-Z0-9]/g, "_")}">
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

    const res = await apiFetch(`${API}/api/attendance/absent-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  // Show skeleton loading for exam grid
  showSkeleton("att-exam-grid", "cards");

  // Wire static buttons once. addEventListener is idempotent against re-entry
  // because we check a marker attribute. This guarantees the buttons work
  // regardless of CSP (script-src-attr) or any inline-handler issues.
  wireAttendanceButtonsOnce();

  try {
    const res = await fetch(`${API}/api/history`, { credentials: "include" });
    const history = await res.json();
    const grid = document.getElementById("att-exam-grid");

    if (!history || history.length === 0) {
      grid.innerHTML = '<p class="empty-state">No allocations found. Create one first.</p>';
      return;
    }

    grid.innerHTML = history
      .map((h) => {
        const courseLine = formatCourseSummary(h.courses);
        const semLine = formatSemesters(h.courses);
        return `
      <div class="history-card" data-alloc-id="${esc(h._id)}" data-exam-name="${esc(h.examName)}" data-date="${esc(h.date)}" data-session="${esc(h.session)}" style="cursor:pointer;">
        <h4>${esc(h.examName)}${semLine ? ` <span style="font-size:12px;color:var(--text-muted);font-weight:500;">· ${semLine}</span>` : ""}</h4>
        <div class="meta">📅 ${esc(h.date)} · ${esc(h.session)}</div>
        ${courseLine ? `<div class="meta">📚 ${courseLine}</div>` : ""}
        <div class="rooms-count">🏫 ${h.summary ? h.summary.length : 0} room(s)</div>
      </div>`;
      })
      .join("");

    // Wire exam card clicks
    grid.querySelectorAll(".history-card").forEach((card) => {
      card.addEventListener("click", () => {
        const allocId = card.getAttribute("data-alloc-id");
        const examName = card.getAttribute("data-exam-name") || "";
        const date = card.getAttribute("data-date") || "";
        const session = card.getAttribute("data-session") || "";
        if (allocId) attSelectExam(allocId, examName, date, session);
      });
    });
  } catch (err) {
    console.error("Attendance page load error:", err);
  }
}

// Idempotent wiring for the static attendance buttons. Marker attribute
// prevents double-binding even if loadAttendancePage runs multiple times.
function wireAttendanceButtonsOnce() {
  const wireOnce = (id, handler) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.wired === "1") return;
    el.addEventListener("click", handler);
    el.dataset.wired = "1";
  };
  wireOnce("att-back-to-exams", attBackToExams);
  wireOnce("att-back-to-rooms", attBackToRooms);
  wireOnce("att-mark-all-present", attMarkAllPresent);
  wireOnce("att-mark-all-absent", attMarkAllAbsent);
  // Three-way save flow (zip-merged): draft / saved / finalized
  wireOnce("att-save-draft", () => attSaveAttendance("draft"));
  wireOnce("att-save", () => attSaveAttendance("saved"));
  wireOnce("att-finalize", attFinalizeAttendance);
}

async function attSelectExam(allocId, examName, date, session) {
  attSelectedAllocId = allocId;

  document.getElementById("att-exam-select").classList.add("hidden");
  document.getElementById("att-room-select").classList.remove("hidden");
  document.getElementById("att-mark-section").classList.add("hidden");
  // textContent prevents XSS (#10)
  document.getElementById("att-selected-exam-title").textContent =
    `${examName || ""} — ${date || ""} (${session || ""})`;

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
      .map((room) => {
        // (zip-merged) Status badge per room: new / draft / saved / finalized.
        const attData = data.attendance || [];
        const roomAtt = attData.find((a) => a.roomNo === room.roomNo);
        const status = roomAtt ? (roomAtt.status || "draft") : "";
        const badge =
          status === "finalized" ? '<span class="att-status-badge finalized">🔒 Finalized</span>' :
          status === "saved" ? '<span class="att-status-badge saved">✅ Saved</span>' :
          status === "draft" ? '<span class="att-status-badge draft">💾 Draft</span>' :
          '<span class="att-status-badge new">○ Not marked</span>';
        return `
      <div class="att-room-card" data-room-no="${esc(room.roomNo)}">
        <div class="att-room-icon">🏫</div>
        <div class="att-room-name">${esc(room.roomNo)}</div>
        <div class="att-room-count">${room.students.length} students</div>
        ${badge}
      </div>`;
      })
      .join("");

    // Wire click handlers via event delegation so it works regardless of CSP
    // and survives re-renders.
    grid.querySelectorAll(".att-room-card").forEach((card) => {
      card.addEventListener("click", () => {
        const rn = card.getAttribute("data-room-no");
        if (rn) attSelectRoom(allocId, rn);
      });
    });
  } catch (err) {
    alert("Error loading exam: " + err.message);
  }
}

async function attSelectRoom(allocId, roomNo) {
  attSelectedRoomNo = roomNo;

  document.getElementById("att-room-select").classList.add("hidden");
  document.getElementById("att-mark-section").classList.remove("hidden");
  // textContent prevents XSS (#10)
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
    const roomStatus = savedRoom ? (savedRoom.status || "draft") : "new";

    // Build student list with attendance state
    attStudentData = room.students.map((s) => {
      const saved = savedRoom ? savedRoom.students.find((ss) => ss.usn === s.usn) : null;
      return {
        ...s,
        present: saved ? saved.present : true, // Default: present
      };
    });

    renderAttendanceMarking();

    // (zip-merged) Finalized rooms are read-only. Hide action buttons and
    // show the badge; also disable each checkbox.
    const actionBtns = document.getElementById("att-action-buttons");
    const finalizedBadge = document.getElementById("att-finalized-badge");
    if (roomStatus === "finalized") {
      if (actionBtns) actionBtns.classList.add("hidden");
      if (finalizedBadge) finalizedBadge.classList.remove("hidden");
      document
        .querySelectorAll('#att-student-list input[type="checkbox"]')
        .forEach((cb) => { cb.disabled = true; });
    } else {
      if (actionBtns) actionBtns.classList.remove("hidden");
      if (finalizedBadge) finalizedBadge.classList.add("hidden");
    }
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
        <tr class="${s.present ? "" : "absent-row"}" data-usn="${esc(s.usn)}">
          <td>${idx + 1}</td>
          <td class="usn-code">${esc(s.usn)}</td>
          <td>${esc(s.name)}</td>
          <td>
            <label class="att-toggle">
              <input type="checkbox" class="att-row-checkbox" data-usn="${esc(s.usn)}" ${s.present ? "checked" : ""} />
              <span class="att-toggle-label ${s.present ? "present" : "absent"}">${s.present ? "P" : "A"}</span>
            </label>
          </td>
        </tr>`
        )
        .join("");

      return `
        <div class="attendance-sem-section">
          <div class="attendance-sem-label" data-sem="${esc(sem)}">Semester ${esc(sem)} — ${presentCount}/${students.length} Present</div>
          <table class="data-table">
            <thead>
              <tr><th>S.No</th><th>USN</th><th>Name</th><th>Status</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join("");

  // Wire the checkboxes via delegation (CSP-safe, survives re-render)
  container.querySelectorAll(".att-row-checkbox").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const usn = e.target.getAttribute("data-usn");
      attToggleStudent(usn, e.target.checked);
    });
  });
}

// (zip-merged) Toggle one student's attendance in-place (no re-render).
// Keeps scroll position and other checkboxes' visual state intact.
function attToggleStudent(usn, isPresent) {
  const student = attStudentData.find((s) => s.usn === usn);
  if (student) student.present = isPresent;

  // Update only this row's classes + label
  const row = document.querySelector(`tr[data-usn="${CSS.escape(usn)}"]`);
  if (row) {
    const label = row.querySelector(".att-toggle-label");
    if (isPresent) {
      row.classList.remove("absent-row");
      if (label) {
        label.textContent = "P";
        label.classList.remove("absent");
        label.classList.add("present");
      }
    } else {
      row.classList.add("absent-row");
      if (label) {
        label.textContent = "A";
        label.classList.remove("present");
        label.classList.add("absent");
      }
    }
  }

  updateAttendanceCounts();
}

function attMarkAllPresent() {
  attStudentData.forEach((s) => (s.present = true));
  renderAttendanceMarking();
}

function attMarkAllAbsent() {
  attStudentData.forEach((s) => (s.present = false));
  renderAttendanceMarking();
}

async function attSaveAttendance(status) {
  if (!attSelectedAllocId || !attSelectedRoomNo) return;

  try {
    const res = await apiFetch(`${API}/api/attendance/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocationId: attSelectedAllocId,
        roomNo: attSelectedRoomNo,
        status: status || "draft",
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

    alert(data.message || "Attendance saved.");

    // After Save / Finalize, return to room list so the new badge shows.
    if (typeof attBackToRooms === "function") attBackToRooms();
  } catch (err) {
    alert("Error: " + err.message);
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

  // Show skeleton loading for reports exam grid
  showSkeleton("rpt-exam-grid", "cards");

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
      .map((h) => {
        const courseLine = formatCourseSummary(h.courses);
        const semLine = formatSemesters(h.courses);
        return `
      <div class="history-card" data-alloc-id="${esc(h._id)}" style="cursor:pointer;">
        <h4>${esc(h.examName)}${semLine ? ` <span style="font-size:12px;color:var(--text-muted);font-weight:500;">· ${semLine}</span>` : ""}</h4>
        <div class="meta">📅 ${esc(h.date)} · ${esc(h.session)}</div>
        ${courseLine ? `<div class="meta">📚 ${courseLine}</div>` : ""}
        <div class="rooms-count">🏫 ${h.summary ? h.summary.length : 0} room(s)</div>
      </div>`;
      })
      .join("");

    // Wire clicks via addEventListener — survives CSP and re-renders
    grid.querySelectorAll(".history-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.getAttribute("data-alloc-id");
        if (id) rptSelectExam(id);
      });
    });
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
    // textContent prevents XSS (#10)
    document.getElementById("rpt-exam-title").textContent =
      `${data.examName || ""} — ${data.date || ""} (${data.session || ""})`;

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
    renderReportDownloadButtons(data);
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
          .map((s, i) => `<tr><td>${i + 1}</td><td class="usn-code">${esc(s.usn)}</td><td>${esc(s.name)}</td><td>${esc(s.roomNo)}</td></tr>`)
          .join("");

        return `
          <div class="rpt-course-card">
            <div class="rpt-course-header">
              <div>
                <strong>Semester ${esc(sem)}</strong>
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
        .map((s, i) => `<tr><td>${i + 1}</td><td class="usn-code">${esc(s.usn)}</td><td>${esc(s.name)}</td><td>${esc(s.roomNo)}</td></tr>`)
        .join("");

      const courseLabel = `${r.course.courseName || ""} — Absent Report`;
      return `
        <div class="rpt-course-card">
          <div class="rpt-course-header">
            <div>
              <strong>${esc(r.course.courseName)}</strong> (${esc(r.course.courseCode)})
              <span style="color:var(--text-secondary);font-size:0.85rem;"> — Sem ${esc(r.course.semester)}</span>
            </div>
            <div class="rpt-stats">
              <span class="rpt-stat present">✓ ${r.present.length} Present</span>
              <span class="rpt-stat absent">✗ ${r.absent.length} Absent</span>
              <span class="rpt-stat total">Total: ${r.total}</span>
              <button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="openPdfPreview('${API}/api/pdf/absent-report/${encodeURIComponent(rptSelectedAllocId)}/course/${courses.indexOf(r.course)}', ${JSON.stringify(esc(courseLabel))})">📄 PDF</button>
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
            .map((s, i) => `<tr><td>${i + 1}</td><td class="usn-code">${esc(s.usn)}</td><td>${esc(s.name)}</td></tr>`)
            .join("");
          return `
            <div style="margin-top:0.5rem;">
              <div class="attendance-sem-label">Sem ${esc(sem)} — ${students.length} absent</div>
              <table class="data-table"><thead><tr><th>S.No</th><th>USN</th><th>Name</th></tr></thead><tbody>${rows}</tbody></table>
            </div>`;
        })
        .join("");

      const roomLabel = `Room ${room.roomNo} — Absent Report`;
      return `
        <div class="rpt-course-card">
          <div class="rpt-course-header">
            <div><strong>Room: ${esc(room.roomNo)}</strong></div>
            <div class="rpt-stats">
              <span class="rpt-stat present">✓ ${present.length}</span>
              <span class="rpt-stat absent">✗ ${absent.length}</span>
              <span class="rpt-stat total">Total: ${room.students.length}</span>
              <button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="openPdfPreview('${API}/api/pdf/absent-report/${encodeURIComponent(rptSelectedAllocId)}/room/${encodeURIComponent(room.roomNo)}', ${JSON.stringify(esc(roomLabel))})">📄 PDF</button>
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

function renderReportDownloadButtons(data) {
  const container = document.getElementById("rpt-download-buttons");
  const courses = data.courses || [];

  let html = `<button class="btn-primary" onclick="openPdfPreview('${API}/api/pdf/absent-report/${encodeURIComponent(rptSelectedAllocId)}', 'Complete Absent Report')">📄 Complete Report</button>`;

  if (courses.length > 0) {
    courses.forEach((course, idx) => {
      const label = `${course.courseName || ""} (Sem ${course.semester || ""})`;
      const labelHtml = esc(label);
      const labelArg = JSON.stringify(esc(`${label} — Absent Report`));
      html += `<button class="btn-outline" onclick="openPdfPreview('${API}/api/pdf/absent-report/${encodeURIComponent(rptSelectedAllocId)}/course/${idx}', ${labelArg})">📄 ${labelHtml}</button>`;
    });
  }

  container.innerHTML = html;
}
