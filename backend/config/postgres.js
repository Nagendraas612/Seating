// PostgreSQL connection (Neon) — department project database
//
// The seating module's tables live in Postgres on Neon. MongoDB still runs
// the app until the models move over, one route at a time.
//
// Needs DATABASE_URL in backend/.env — copy it from the Neon console
// (Connect button, pooled string). Never commit .env.

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

let pool = null;

if (connectionString) {
  pool = new Pool({
    connectionString,
    // Neon requires SSL. This is Neon's own documented setting for pg.
    ssl: true,
  });

  // A failed idle client must not crash the server silently.
  pool.on("error", (err) => {
    console.error("Postgres pool error:", err.message);
  });
} else {
  console.warn(
    "DATABASE_URL is not set — Postgres is not connected. " +
      "Add it to backend/.env (Neon console, Connect button)."
  );
}

module.exports = { pool };
