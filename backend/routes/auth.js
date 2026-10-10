// Refactored module (pure move from server.js): auth routes

const express = require("express");
const passport = require("passport");
const bcrypt = require("bcryptjs");
const AdminUser = require("../models/AdminUser");
const { isAdminLoggedIn } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// AUTH ROUTES
// ============================================================

// Start Google login
router.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    prompt: "select_account", // Always show account picker, never auto-select
  })
);

// Google redirects here after login
router.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=unauthorized_domain" }),
  (req, res) => {
    // Redirect to frontend dashboard after successful login
    res.redirect(process.env.FRONTEND_URL || "http://localhost:3000");
  }
);

// Logout
router.get("/auth/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destroy error:", err);
      }
      res.clearCookie("connect.sid"); // Remove the session cookie from browser
      res.redirect("/");
    });
  });
});

// Check login status (frontend calls this on load)
router.get("/auth/status", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      loggedIn: true,
      user: {
        name: req.user.displayName,
        email: req.user.emails[0].value,
        photo: req.user.photos[0]?.value,
      },
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============================================================
// ADMIN AUTH ROUTES (username + password, stored in MongoDB)
// ============================================================

// Admin login
router.post("/auth/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const admin = await AdminUser.findOne({ username: username.trim().toLowerCase() });
    if (!admin) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // Store admin session and explicitly save before responding
    req.session.adminUser = { id: admin._id, username: admin.username };
    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      res.json({ success: true, username: admin.username });
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin logout
router.post("/auth/admin/logout", (req, res) => {
  req.session.adminUser = null;
  res.json({ success: true });
});

// Admin status check
router.get("/auth/admin/status", (req, res) => {
  if (req.session && req.session.adminUser) {
    res.json({ loggedIn: true, username: req.session.adminUser.username });
  } else {
    res.json({ loggedIn: false });
  }
});

// Admin: create a new admin account (only callable when logged in as admin, or first-time setup)
router.post("/auth/admin/register", async (req, res) => {
  try {
    // Allow registration only if already logged in as admin OR no admins exist yet
    const adminCount = await AdminUser.countDocuments();
    const isFirstSetup = adminCount === 0;
    const isLoggedInAdmin = req.session && req.session.adminUser;

    if (!isFirstSetup && !isLoggedInAdmin) {
      return res.status(403).json({ error: "Only existing admins can create new admin accounts." });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const existing = await AdminUser.findOne({ username: username.trim().toLowerCase() });
    if (existing) {
      return res.status(400).json({ error: "Username already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = new AdminUser({ username: username.trim().toLowerCase(), passwordHash });
    await admin.save();

    res.json({ success: true, message: "Admin account created." });
  } catch (err) {
    console.error("Admin register error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: list all admin accounts (usernames only)
router.get("/auth/admin/list", isAdminLoggedIn, async (req, res) => {
  try {
    const admins = await AdminUser.find({}, { username: 1, createdAt: 1 });
    res.json(admins);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: delete an admin account
router.delete("/auth/admin/:id", isAdminLoggedIn, async (req, res) => {
  try {
    const count = await AdminUser.countDocuments();
    if (count <= 1) {
      return res.status(400).json({ error: "Cannot delete the last admin account." });
    }
    await AdminUser.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
