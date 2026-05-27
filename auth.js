// Google/Facebook auth scaffold.
// Runs in guest-only mode with no credentials. The moment you set the env vars
// (GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET, BASE_URL, SESSION_SECRET),
// the real OAuth routes activate — no code changes needed.

function normalize(provider, profile) {
  return {
    id: provider + ':' + profile.id,
    provider,
    name: profile.displayName || (profile.name && profile.name.givenName) || 'Player',
    avatar: (profile.photos && profile.photos[0] && profile.photos[0].value) || null,
  };
}

function setupAuth(app) {
  const providers = {
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebook: !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET),
  };
  const anyConfigured = providers.google || providers.facebook;

  // Guest-only mode: expose a minimal /auth/me so the client knows login is off.
  if (!anyConfigured) {
    app.get('/auth/me', (req, res) => res.json({ authenticated: false, user: null, providers }));
    app.get(['/auth/google', '/auth/facebook'], (req, res) =>
      res.status(503).json({ error: 'Login is not configured yet.' }));
    app.get('/auth/logout', (req, res) => res.redirect('/'));
    console.log('Auth: no provider credentials — guest-only mode.');
    return;
  }

  let session, passport;
  try {
    session = require('express-session');
    passport = require('passport');
  } catch (e) {
    console.warn('Auth deps not installed; guest-only mode:', e.message);
    app.get('/auth/me', (req, res) =>
      res.json({ authenticated: false, user: null, providers: { google: false, facebook: false } }));
    return;
  }

  app.set('trust proxy', 1);
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'wordrace-' + Math.random().toString(36).slice(2),
      resave: false,
      saveUninitialized: false,
      cookie: { sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());
  passport.serializeUser((u, done) => done(null, u));
  passport.deserializeUser((u, done) => done(null, u));

  const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');

  if (providers.google) {
    const GoogleStrategy = require('passport-google-oauth20').Strategy;
    passport.use(new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: BASE + '/auth/google/callback',
      },
      (accessToken, refreshToken, profile, done) => done(null, normalize('google', profile))
    ));
    app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
    app.get('/auth/google/callback',
      passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
      (req, res) => res.redirect('/?auth=ok'));
  } else {
    app.get('/auth/google', (req, res) => res.status(503).json({ error: 'Google login not configured.' }));
  }

  if (providers.facebook) {
    const FacebookStrategy = require('passport-facebook').Strategy;
    passport.use(new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: BASE + '/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'photos'],
      },
      (accessToken, refreshToken, profile, done) => done(null, normalize('facebook', profile))
    ));
    app.get('/auth/facebook', passport.authenticate('facebook'));
    app.get('/auth/facebook/callback',
      passport.authenticate('facebook', { failureRedirect: '/?auth=failed' }),
      (req, res) => res.redirect('/?auth=ok'));
  } else {
    app.get('/auth/facebook', (req, res) => res.status(503).json({ error: 'Facebook login not configured.' }));
  }

  app.get('/auth/me', (req, res) =>
    res.json({ authenticated: !!req.user, user: req.user || null, providers }));
  app.get('/auth/logout', (req, res) => {
    if (typeof req.logout === 'function') {
      req.logout(() => res.redirect('/'));
    } else {
      res.redirect('/');
    }
  });

  console.log(`Auth: enabled (google=${providers.google}, facebook=${providers.facebook}).`);
}

module.exports = { setupAuth };
