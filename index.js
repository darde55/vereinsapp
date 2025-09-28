require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const app = express();

const PORT = process.env.PORT || 3000;

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

// --- JWT Auth Middleware ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Token fehlt' });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Token ungültig' });
    }
    req.user = user;
    next();
  });
}

// --- Healthcheck ---
app.get('/api/ping', (req, res) => {
  res.json({ message: 'pong' });
});

// --- Registrierung ---
app.post('/api/register', async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password || !role) {
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password, role, score) VALUES ($1, $2, $3, $4, $5)',
      [username, email, hashedPassword, role, 0]
    );
    res.status(201).json({ message: 'User registriert' });
  } catch (err) {
    if (err.code === '23505') {
      res.status(409).json({ message: 'Username existiert bereits' });
    } else {
      res.status(500).json({ message: 'Fehler bei Registrierung', error: err.message });
    }
  }
});

// --- Login ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0)
      return res.status(401).json({ message: 'User nicht gefunden' });

    const user = result.rows[0];
    if (!(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Passwort falsch' });

    const token = jwt.sign(
      { username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Login', error: err.message });
  }
});

// --- Profil (geschützt) ---
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, email, role, score FROM users WHERE username = $1',
      [req.user.username]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ message: 'User nicht gefunden' });
    // Guarantee: always return all properties!
    const user = result.rows[0];
    // Fallbacks for missing properties
    res.json({
      username: user.username || "",
      email: user.email || "",
      role: user.role || "",
      score: user.score != null ? user.score : 0
    });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden des Profils', error: err.message });
  }
});

// --- Eigene Termine ---
app.get('/api/profile/termine', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.* FROM termine t
       JOIN teilnahmen tn ON t.id = tn.termin_id
       WHERE tn.username = $1
       ORDER BY t.datum ASC`,
      [req.user.username]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden deiner Termine', error: err.message });
  }
});

// --- Benutzerverwaltung (Admin) ---
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT username, email, role, score FROM users');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Benutzer', error: err.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password || !role) {
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password, role, score) VALUES ($1, $2, $3, $4, $5)',
      [username, email, hashedPassword, role, 0]
    );
    res.status(201).json({ message: 'User angelegt' });
  } catch (err) {
    if (err.code === '23505') {
      res.status(409).json({ message: 'Username existiert bereits' });
    } else {
      res.status(500).json({ message: 'Fehler beim Anlegen', error: err.message });
    }
  }
});

app.put('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;
  const { email, role, score } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET email=$1, role=$2, score=$3 WHERE username=$4 RETURNING *',
      [email, role, score, username]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Bearbeiten des Benutzers', error: err.message });
  }
});

app.delete('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;
  try {
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ message: 'Benutzer gelöscht' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Löschen des Benutzers', error: err.message });
  }
});

// --- Termine mit Teilnehmern! ---
app.get('/api/termine', async (req, res) => {
  try {
    const termineRes = await pool.query('SELECT * FROM termine ORDER BY datum ASC');
    const termine = termineRes.rows;
    for (const termin of termine) {
      const teilnehmerRes = await pool.query(
        `SELECT username FROM teilnahmen WHERE termin_id = $1`,
        [termin.id]
      );
      termin.teilnehmer = teilnehmerRes.rows;
    }
    res.json(termine);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Termine', error: err.message });
  }
});

// --- Teilnahme an/abmelden ---
app.post('/api/termine/:id/teilnehmen', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.body.username || req.user.username;
  try {
    const check = await pool.query(
      'SELECT * FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, username]
    );
    if (check.rows.length > 0) {
      return res.status(409).json({ message: 'Du bist bereits angemeldet.' });
    }
    await pool.query(
      'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)',
      [termin_id, username]
    );
    res.json({ message: 'Teilnahme gespeichert.' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler bei Teilnahme', error: err.message });
  }
});

app.delete('/api/termine/:id/teilnehmen', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.user.username;
  try {
    await pool.query(
      'DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, username]
    );
    res.json({ message: 'Teilnahme entfernt' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Entfernen der Teilnahme', error: err.message });
  }
});

app.get('/api/termine/:id/teilnehmer', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  try {
    const result = await pool.query(
      `SELECT users.username, users.email, users.score
       FROM teilnahmen
       JOIN users ON users.username = teilnahmen.username
       WHERE teilnahmen.termin_id = $1`,
      [termin_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Teilnehmer', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});