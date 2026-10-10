// Refactored module (pure move from server.js): multer upload instance

const multer = require("multer");
const path = require("path");

// ============================================================
// FILE UPLOAD SETUP (multer - stores in memory for processing)
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max per file
  fileFilter: (req, file, cb) => {
    const allowedExt = [".xlsx", ".xls", ".csv"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${ext}. Only .xlsx, .xls, .csv are allowed.`));
    }
  },
});

module.exports = upload;
