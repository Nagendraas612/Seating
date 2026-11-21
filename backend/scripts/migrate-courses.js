// Copies existing courses from MongoDB into Postgres (one-time move).
//
// Run from the backend folder:  npm run migrate:courses
// Needs MONGO_URI and DATABASE_URL in backend/.env.
// Safe to run twice: courses already in Postgres are skipped, not duplicated.
//
// Skip this script if you prefer to re-enter the courses by hand in admin.

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

  // Minimal read-only schema for the old collection. The CourseData model
  // file is gone after Stage 1, so this script does not depend on it.
  const LegacyCourse = mongoose.model(
    "LegacyCourse",
    new mongoose.Schema(
      { semester: String, courseName: String, courseCode: String },
      { collection: "coursedatas" }
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
  if (!names.includes("coursedatas")) {
    console.error(
      "No 'coursedatas' collection in this Mongo database. " +
        "Check MONGO_URI points at the Seating database. " +
        `Collections found: ${names.join(", ") || "none"}.`
    );
    await close();
    process.exit(1);
  }

  const docs = await LegacyCourse.find().lean();
  console.log(`Found ${docs.length} course document(s) in Mongo.`);

  let inserted = 0;
  let skipped = 0;
  for (const doc of docs) {
    const code = (doc.courseCode || "").trim();
    const name = (doc.courseName || "").trim();
    const semester = (doc.semester || "").trim();
    if (!code || !name || !semester) {
      skipped++;
      console.log(`Skipped incomplete row: ${JSON.stringify(doc)}`);
      continue;
    }
    const result = await pool.query(
      "INSERT INTO course (course_id, course_name, semester) VALUES ($1, $2, $3) ON CONFLICT (course_id) DO NOTHING",
      [code, name, semester]
    );
    if (result.rowCount === 1) {
      inserted++;
    } else {
      skipped++;
      console.log(`Already in Postgres, skipped: ${code}`);
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
