// Refactored module (pure move from server.js): MongoDB connection

const mongoose = require("mongoose");

// ============================================================
// MONGODB CONNECTION
// ============================================================

mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/aiml_seats")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));
