// Refactored module (pure move from server.js): Google OAuth / passport setup

const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

function setupPassport() {
// ============================================================
// GOOGLE OAUTH SETUP
// ============================================================

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      const email = profile.emails && profile.emails[0] && profile.emails[0].value;
      if (!email || !email.endsWith("@vvce.ac.in")) {
        return done(null, false, { message: "Access restricted to @vvce.ac.in accounts only." });
      }
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

  return passport;
}

module.exports = { setupPassport };
