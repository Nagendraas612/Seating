// Proves the app can reach the Neon Postgres database.
//
// Run from the backend folder:  npm run test:db
// Needs DATABASE_URL in backend/.env (Neon console, Connect button).
//
// Exit 0 = connected and all 8 seating tables found.
// Exit 1 = something is wrong; the printed REASON names the broken step.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { pool } = require("../config/postgres");

const EXPECTED_TABLES = [
  "attendance",
  "course",
  "exam",
  "exam_course_mapping",
  "faculty",
  "room",
  "seating_allocation",
  "student",
];

function fail(reason, detail) {
  console.error("\nREASON: " + reason);
  if (detail) console.error("Detail: " + detail);
  console.error("Fix that step, then run npm run test:db again.");
  process.exit(1);
}

async function main() {
  if (!pool) {
    fail(
      "DATABASE_URL is not set",
      "Add DATABASE_URL=<the Neon pooled connection string> to backend/.env. " +
        "Copy it from the Neon console with the Connect button (reveal the password first)."
    );
  }

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    if (err.code === "28P01") {
      fail(
        "Wrong password or role",
        "Neon refused the login. Copy the connection string again from the Neon console — reveal the password before copying."
      );
    }
    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      fail(
        "Cannot reach the Neon host",
        "Check the internet connection and that the host in DATABASE_URL is the one from the Neon console."
      );
    }
    if (err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
      fail(
        "Connection timed out or refused",
        "Neon may be waking the compute (it sleeps when idle). Wait a few seconds and try again."
      );
    }
    if (err.code === "3D000") {
      fail(
        "Database does not exist",
        "DATABASE_URL points to a database name that is not on this Neon branch. It should end with /neondb."
      );
    }
    fail("Could not connect to Postgres", err.message);
  }

  try {
    const version = await client.query("SELECT version()");
    console.log("Connected to Postgres:");
    console.log(version.rows[0].version);

    const found = await client.query(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'public' ORDER BY table_name"
    );
    const names = found.rows.map((r) => r.table_name);
    console.log("\nTables in neondb (public): " + (names.join(", ") || "none"));

    const missing = EXPECTED_TABLES.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      fail(
        "Connected, but tables are missing: " + missing.join(", "),
        "Run the seating-necessary-tables SQL in the Neon SQL Editor first."
      );
    }

    console.log("\nAll 8 seating tables found. Postgres is connected.");
  } finally {
    client.release();
    await pool.end();
  }
}

main();
