// Copies existing rooms from MongoDB into Postgres (one-time move).
//
// Run from the backend folder:  npm run migrate:rooms
// Needs MONGO_URI and DATABASE_URL in backend/.env.
// Safe to run twice: rooms already in Postgres are skipped, not duplicated.
//
// Skip this script if you prefer to re-enter the rooms by hand in admin.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { pool } = require("../config/postgres");

async function close() {
  try {
    await mongoose.disconnect();
  } catch (_) {
    // Already disconnected — nothing to do.
  }
  if (pool) {
    try {
      await pool.end();
    } catch (_) {
      // Already closed — nothing to do.
    }
  }
}

async function main() {
  if (!pool) {
    console.error("DATABASE_URL is not set in backend/.env — cannot write to Postgres.");
    process.exit(1);
  }
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/aiml_seats";

  // Minimal read-only schema for the old collection. The Room model
  // file is gone after Stage 2, so this script does not depend on it.
  const LegacyRoom = mongoose.model(
    "LegacyRoom",
    new mongoose.Schema(
      { roomNo: String, benches: Number, enabled: Boolean },
      { collection: "rooms" }
    )
  );

  try {
    await mongoose.connect(mongoUri);
  } catch (err) {
    console.error("Could not connect to MongoDB:", err.message);
    await close();
    process.exit(1);
  }
  console.log(`Connected to Mongo: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const collections = await mongoose.connection.db.listCollections().toArray();
  const names = collections.map((c) => c.name);
  if (!names.includes("rooms")) {
    console.error(
      "No 'rooms' collection in this Mongo database. " +
        "Check MONGO_URI points at the Seating database. " +
        `Collections found: ${names.join(", ") || "none"}.`
    );
    await close();
    process.exit(1);
  }

  const docs = await LegacyRoom.find().lean();
  console.log(`Found ${docs.length} room document(s) in Mongo.`);

  let inserted = 0;
  let skipped = 0;
  for (const doc of docs) {
    const roomNo = (doc.roomNo || "").trim();
    const benches = doc.benches;
    const enabled = doc.enabled !== false;
    if (!roomNo || benches === undefined || benches === null) {
      skipped++;
      console.log(`Skipped incomplete row: ${JSON.stringify(doc)}`);
      continue;
    }
    const result = await pool.query(
      "INSERT INTO room (room_number, number_of_benches, is_enabled) VALUES ($1, $2, $3) ON CONFLICT (room_number) DO NOTHING",
      [roomNo, benches, enabled]
    );
    if (result.rowCount === 1) {
      inserted++;
    } else {
      skipped++;
      console.log(`Already in Postgres, skipped: ${roomNo}`);
    }
  }

  console.log(`Done. Inserted ${inserted}, skipped ${skipped}.`);
  await close();
}

main().catch(async (err) => {
  console.error("Migration failed:", err.message);
  await close();
  process.exit(1);
});
