// Refactored module (pure move from server.js): CourseData model

const mongoose = require("mongoose");

// --- CourseData Schema ---
// Stores course name + code per semester, entered by admin
const courseDataSchema = new mongoose.Schema({
  semester: { type: String, required: true },
  courseName: { type: String, required: true },
  courseCode: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const CourseData = mongoose.model("CourseData", courseDataSchema);

module.exports = CourseData;
