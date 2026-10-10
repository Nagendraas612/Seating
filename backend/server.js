// ============================================================
// AIML Internal Examination Seat Allotment System - Backend
// ============================================================
// server.js - Main entry point
// Handles: Google OAuth, File Upload, Seating Algorithm, PDFs, MongoDB
// ============================================================

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const { apiLimiter, authLimiter } = require("./middleware/rateLimit");
const { setupPassport } = require("./auth/passport");

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const allocateRoutes = require("./routes/allocate");
const historyRoutes = require("./routes/history");
const attendanceRoutes = require("./routes/attendance");
const pdfRoutes = require("./routes/pdf");

const app = express();
const PORT = process.env.PORT || 5000;

app.set("trust proxy", 1);

// ============================================================
// MIDDLEWARE SETUP
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

app.use(express.static(path.join(__dirname, "../frontend")));

// ============================================================
// RATE LIMITING
// ============================================================

app.use("/api/", apiLimiter);

app.use("/auth/", authLimiter);

require("./config/database");

// ============================================================
// MONGODB SCHEMAS & MODELS
// ============================================================

require("./models/Room");
require("./models/Allocation");
require("./models/AdminUser");
require("./models/StudentData");
require("./models/CourseData");

// ============================================================
// SESSION SETUP (uses MongoDB to persist sessions)
// ============================================================

// Fail fast if SESSION_SECRET is not set in production
if (!process.env.SESSION_SECRET) {
  console.error("❌ SESSION_SECRET environment variable is not set. Refusing to start.");
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === "production";

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI || "mongodb://localhost:27017/aiml_seats",
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,              // JS cannot read the cookie (blocks XSS theft)
      secure: isProduction,        // HTTPS only in production
      sameSite: "lax",             // Blocks cross-site request forgery
    },
  })
);

const passport = setupPassport();

app.use(passport.initialize());
app.use(passport.session());

app.use("/", authRoutes);
app.use("/", adminRoutes);
app.use("/", allocateRoutes);
app.use("/", historyRoutes);
app.use("/", attendanceRoutes);
app.use("/", pdfRoutes);

// ============================================================
// CATCH-ALL: Serve frontend for any unmatched route (SPA support)
// ============================================================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ============================================================
// GLOBAL ERROR HANDLER
// Catches any unhandled errors — never leaks stack traces in production
// ============================================================

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  const isDev = process.env.NODE_ENV !== "production";
  res.status(err.status || 500).json({
    error: isDev ? err.message : "An internal server error occurred.",
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
