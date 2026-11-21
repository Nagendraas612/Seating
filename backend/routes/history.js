// Refactored module (pure move from server.js): allocation history routes

const express = require("express");
const { loadAllocation, loadAllocationSummaries, deleteAllocation } = require("../utils/allocationLoader");
const { isLoggedIn } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// HISTORY ROUTES
// ============================================================

// GET all past allocations (list view)
router.get("/api/history", isLoggedIn, async (req, res) => {
  try {
    res.json(await loadAllocationSummaries());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE an allocation
router.delete("/api/history/:id", isLoggedIn, async (req, res) => {
  try {
    await deleteAllocation(req.params.id);
    res.json({ message: "Allocation deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a specific allocation by ID (full detail)
router.get("/api/history/:id", isLoggedIn, async (req, res) => {
  try {
    const allocation = await loadAllocation(req.params.id);
    if (!allocation) return res.status(404).json({ error: "Not found" });
    res.json(allocation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
