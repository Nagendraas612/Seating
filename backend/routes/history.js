// Refactored module (pure move from server.js): allocation history routes

const express = require("express");
const Allocation = require("../models/Allocation");
const { isLoggedIn } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// HISTORY ROUTES
// ============================================================

// GET all past allocations (list view)
router.get("/api/history", isLoggedIn, async (req, res) => {
  try {
    const list = await Allocation.find(
      {},
      { examName: 1, date: 1, session: 1, createdAt: 1, summary: 1, courses: 1 }
    ).sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE an allocation
router.delete("/api/history/:id", isLoggedIn, async (req, res) => {
  try {
    await Allocation.findByIdAndDelete(req.params.id);
    res.json({ message: "Allocation deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a specific allocation by ID (full detail)
router.get("/api/history/:id", isLoggedIn, async (req, res) => {
  try {
    const allocation = await Allocation.findById(req.params.id);
    if (!allocation) return res.status(404).json({ error: "Not found" });
    res.json(allocation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
