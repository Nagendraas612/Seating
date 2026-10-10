// Refactored module (pure move from server.js): auth middleware

// ============================================================
// AUTH MIDDLEWARE
// Protect routes - only logged-in users can access
// ============================================================

function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Unauthorized. Please login with Google." });
}

// Admin middleware — checks session for admin login
function isAdminLoggedIn(req, res, next) {
  if (req.session && req.session.adminUser) return next();
  res.status(401).json({ error: "Unauthorized. Admin login required." });
}

module.exports = { isLoggedIn, isAdminLoggedIn };
