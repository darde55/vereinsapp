require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const app = express();

const PORT = process.env.PORT || 3000;

console.log('===== ENV Logging =====');
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'gesetzt' : 'NICHT gesetzt');
console.log('JWT_SECRET:', process.env.JWT_SECRET);
console.log('PORT:', PORT);
console.log('MAIL_FROM:', process.env.MAIL_FROM);
console.log('=======================');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("SendGrid API Key ist gesetzt.");
} else {
  console.error("SendGrid API Key fehlt! Bitte prüfe deine .env Datei.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// --- JWT Auth Middleware ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  console.log('[Auth] Request Header:', authHeader);
  console.log('[Auth] JWT_SECRET beim Token-Prüfen:', process.env.JWT_SECRET); // <--- Logging!
  if (!token) {
    console.log('[Auth] Kein Token gefunden!');
    return res.status(401).json({ message: 'Token fehlt' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    console.log('[Auth] Token gültig, decoded User:', decoded);
    next();
  } catch (err) {
    console.log('[Auth] Token ungültig! Fehler:', err.message);
    return res.status(403).json({ message: 'Token ungültig', error: err.message });
  }
}

// --- Login ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log('[Login] Input:', req.body);
  if (!username || !password) {
    console.log('[Login] Fehlende Felder!');
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    console.log('[Login] DB-Ergebnis:', result.rows);
    if (result.rows.length === 0)
      return res.status(401).json({ message: 'User nicht gefunden' });

    const user = result.rows[0];
    if (!(await bcrypt.compare(password, user.password))) {
      console.log('[Login] Passwort falsch!');
      return res.status(401).json({ message: 'Passwort falsch' });
    }

    console.log('[Login] JWT_SECRET beim Token-Erzeugen:', process.env.JWT_SECRET); // <--- Logging!
    const token = jwt.sign(
      { username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    console.log('[Login] Erfolgreich, User:', user.username, '| Token:', token);
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    console.error('[Login] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Login', error: err.message });
  }
});

// --- Profil (geschützt) ---
app.get('/api/profile', authenticateToken, async (req, res) => {
  console.log('==== /api/profile ====');
  console.log('[Profile] JWT User:', req.user);
  console.log('[Profile] Request Headers:', req.headers);

  try {
    const username = req.user.username;
    console.log('[Profile] Query mit username:', username);

    const result = await pool.query(
      'SELECT username, email, role, score FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    console.log('[Profile] DB-Ergebnis:', result.rows);

    if (result.rows.length === 0) {
      console.log('[Profile] Kein User gefunden mit:', username);
      return res.status(404).json({ message: `User ${username} nicht gefunden` });
    }

    const user = result.rows[0];
    const responseObj = {
      username: user.username || "",
      email: user.email || "",
      role: user.role || "",
      score: user.score != null ? user.score : 0
    };
    console.log('[Profile] Response:', responseObj);
    res.json(responseObj);
  } catch (err) {
    console.error('[Profile] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Laden des Profils', error: err.message });
  }
});

// --- Healthcheck ---
app.get('/api/ping', (req, res) => {
  console.log('[Ping] /api/ping aufgerufen');
  res.json({ message: 'pong' });
});

// --- Registrierung, Termine, weitere Endpunkte wie gehabt ---
// ... (Hier kannst du deine weiteren Routen wie gehabt lassen)

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});