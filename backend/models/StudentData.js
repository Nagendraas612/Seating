// Refactored module (pure move from server.js): StudentData model

const mongoose = require("mongoose");

// --- StudentData Schema ---
// Stores student lists per semester, uploaded by admin via Excel
const studentDataSchema = new mongoose.Schema({
  semester: { type: String, required: true }, // "I", "II", ..., "VIII"
  students: [
    {
      name: { type: String, required: true },
      usn:  { type: String, required: true },
    },
  ],
  uploadedAt: { type: Date, default: Date.now },
});
// One document per semester — upsert on re-upload
studentDataSchema.index({ semester: 1 }, { unique: true });
const StudentData = mongoose.model("StudentData", studentDataSchema);

module.exports = StudentData;
