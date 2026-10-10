// Refactored module (pure move from server.js): Allocation model

const mongoose = require("mongoose");

// --- Allocation History Schema ---
// Stores each exam's seating allocation for history/reuse
const allocationSchema = new mongoose.Schema({
  examName: String,
  date: String,
  session: String, // Morning / Afternoon
  createdAt: { type: Date, default: Date.now },
  // Course details per semester
  courses: [
    {
      courseName: String,
      courseCode: String,
      semester: String, // I, II, III, IV, V, VI, VII, VIII
    },
  ],
  rooms: [
    {
      roomNo: String,
      benches: Number,
      seating: [
        {
          row: Number,
          bench: Number,
          left: { name: String, usn: String, semester: String },
          middle: { name: String, usn: String, semester: String },
          right: { name: String, usn: String, semester: String },
        },
      ],
    },
  ],
  // Summary: notice board view
  summary: [
    {
      roomNo: String,
      semesters: [String],
      usnRanges: [String],
      studentCount: Number,
    },
  ],
  // Flat list for attendance sheets
  attendanceByRoom: [
    {
      roomNo: String,
      students: [{ name: String, usn: String, semester: String }],
    },
  ],
  // Saved attendance (marked by faculty)
  attendance: [
    {
      roomNo: String,
      status: { type: String, enum: ["draft", "saved", "finalized"], default: "draft" },
      savedAt: { type: Date, default: Date.now },
      students: [
        {
          usn: String,
          name: String,
          semester: String,
          present: { type: Boolean, default: true },
        },
      ],
    },
  ],
});
const Allocation = mongoose.model("Allocation", allocationSchema);

module.exports = Allocation;
