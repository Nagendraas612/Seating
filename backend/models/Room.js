// Refactored module (pure move from server.js): Room model

const mongoose = require("mongoose");

// --- Room Schema ---
// Stores room details like room number, bench count, enabled status
const roomSchema = new mongoose.Schema({
  roomNo: { type: String, required: true, unique: true },
  benches: { type: Number, required: true },
  enabled: { type: Boolean, default: true },
});
const Room = mongoose.model("Room", roomSchema);

module.exports = Room;
