// Refactored module (pure move from server.js): AdminUser model

const mongoose = require("mongoose");

// --- AdminUser Schema ---
// Stores admin credentials (username + bcrypt-hashed password)
const adminUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const AdminUser = mongoose.model("AdminUser", adminUserSchema);

module.exports = AdminUser;
