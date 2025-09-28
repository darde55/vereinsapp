require('dotenv').config();

console.log('DATABASE_URL aus ENV:', process.env.DATABASE_URL);
console.log('SENDGRID_API_KEY aus ENV:', process.env.SENDGRID_API_KEY ? 'gesetzt' : 'NICHT gesetzt');
console.log('JWT_SECRET aus ENV:', process.env.JWT_SECRET ? 'gesetzt' : 'NICHT gesetzt');
console.log('PORT aus ENV:', process.env.PORT);
console.log('MAIL_FROM aus ENV:', process.env.MAIL_FROM);

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const cron = require('node-cron');

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
  console.log('[Auth] Authorization Header:', authHeader);
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    console.log('[Auth] Kein Token gefunden!');
    return res.status(401).json({ message: 'Token fehlt' });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log('[Auth] Token ungültig!', err);
      return res.status(403).json({ message: 'Token ungültig' });
    }
    req.user = user;
    console.log('[Auth] Token gültig, User:', user);
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
  console.log('[Register] Input:', req.body);
  if (!username || !email || !password || !role) {
    console.log('[Register] Fehlende Felder!');
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4)',
      [username, email, hashedPassword, role]
    );
    console.log('[Register] User registriert:', username);
    res.status(201).json({ message: 'User registriert' });
  } catch (err) {
    console.error('[Register] Fehler:', err);
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
  console.log('[Login] Input:', req.body);
  if (!username || !password)
    return res.status(400).json({ message: 'Fehlende Felder!' });

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
    console.log('[Login] Erfolgreich, User:', user.username);
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    console.error('[Login] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Login', error: err.message });
  }
});

// --- Profil (geschützt) ---
app.get('/api/profile', authenticateToken, async (req, res) => {
  console.log('[Profile] User:', req.user.username);
  try {
    const result = await pool.query(
      'SELECT username, email, role, score FROM users WHERE username = $1',
      [req.user.username]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ message: 'User nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Profile] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Laden des Profils', error: err.message });
  }
});

// --- Eigene Termine ---
app.get('/api/profile/termine', authenticateToken, async (req, res) => {
  console.log('[Profile/Termine] User:', req.user.username);
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
    console.error('[Profile/Termine] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Laden deiner Termine', error: err.message });
  }
});

// --- Benutzerverwaltung (Admin) ---
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT username, email, role, score FROM users');
    res.json(result.rows);
  } catch (err) {
    console.error('[Users] Fehler:', err);
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
      'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4)',
      [username, email, hashedPassword, role]
    );
    res.status(201).json({ message: 'User angelegt' });
  } catch (err) {
    console.error('[Users] Fehler:', err);
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
    console.error('[Users] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Bearbeiten des Benutzers', error: err.message });
  }
});

app.delete('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;
  try {
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ message: 'Benutzer gelöscht' });
  } catch (err) {
    console.error('[Users] Fehler:', err);
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
      console.log(`[Termine] Termin: ${termin.id}, Teilnehmer:`, termin.teilnehmer);
    }

    res.json(termine);
  } catch (err) {
    console.error('[Termine] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Laden der Termine', error: err.message });
  }
});

app.post('/api/termine', authenticateToken, async (req, res) => {
  const {
    titel, beschreibung, datum, beginn, ende, anzahl,
    stichtag, ansprechpartner_name, ansprechpartner_mail, score
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO termine
        (titel, beschreibung, datum, beginn, ende, anzahl, stichtag, ansprechpartner_name, ansprechpartner_mail, score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [titel, beschreibung, datum, beginn, ende, anzahl, stichtag, ansprechpartner_name, ansprechpartner_mail, score || 0]
    );
    console.log('[Termine] Neuer Termin:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Termine] Fehler beim Erstellen:', err);
    res.status(500).json({ message: 'Fehler beim Erstellen des Termins', error: err.message });
  }
});

app.put('/api/termine/:id', authenticateToken, async (req, res) => {
  const id = req.params.id;
  const {
    titel, beschreibung, datum, beginn, ende, anzahl,
    stichtag, ansprechpartner_name, ansprechpartner_mail, score, stichtag_mail_gesendet
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE termine SET
        titel=$1, beschreibung=$2, datum=$3, beginn=$4, ende=$5, anzahl=$6, stichtag=$7,
        ansprechpartner_name=$8, ansprechpartner_mail=$9, score=$10, stichtag_mail_gesendet=$11
      WHERE id=$12 RETURNING *`,
      [titel, beschreibung, datum, beginn, ende, anzahl, stichtag, ansprechpartner_name, ansprechpartner_mail, score, stichtag_mail_gesendet, id]
    );
    console.log('[Termine] Termin bearbeitet:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Termine] Fehler beim Bearbeiten:', err);
    res.status(500).json({ message: 'Fehler beim Bearbeiten des Termins', error: err.message });
  }
});

app.delete('/api/termine/:id', authenticateToken, async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query('DELETE FROM termine WHERE id = $1', [id]);
    console.log('[Termine] Termin gelöscht:', id);
    res.json({ message: 'Termin gelöscht' });
  } catch (err) {
    console.error('[Termine] Fehler beim Löschen:', err);
    res.status(500).json({ message: 'Fehler beim Löschen des Termins', error: err.message });
  }
});

// --- Teilnahme an/abmelden (mit Logging!) ---
app.post('/api/termine/:id/teilnehmen', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.body.username || req.user.username;
  console.log(`[Teilnahme] Versuch für Termin ${termin_id} mit User ${username}`);
  try {
    // Prüfe, ob User existiert
    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    console.log('[Teilnahme] UserCheck:', userCheck.rows);

    // Prüfe, ob Teilnahme schon existiert
    const check = await pool.query(
      'SELECT * FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, username]
    );
    console.log('[Teilnahme] TeilnahmeCheck:', check.rows);

    if (check.rows.length > 0) {
      console.log('[Teilnahme] User ist bereits Teilnehmer!');
      return res.status(409).json({ message: 'Du bist bereits für diesen Termin angemeldet.' });
    }

    // Teilnahme eintragen
    const result = await pool.query(
      'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2) RETURNING *',
      [termin_id, username]
    );
    console.log('[Teilnahme] InsertResult:', result.rows);

    // Hole E-Mail und Termin-Infos für Bestätigung
    const userRes = await pool.query('SELECT email FROM users WHERE username = $1', [username]);
    const terminRes = await pool.query('SELECT titel, datum, beginn, ende FROM termine WHERE id = $1', [termin_id]);

    if (userRes.rows.length && terminRes.rows.length) {
      const userEmail = userRes.rows[0].email;
      const termin = terminRes.rows[0];

      sgMail.send({
        to: userEmail,
        from: process.env.MAIL_FROM,
        subject: `Bestätigung: Teilnahme am Termin "${termin.titel}"`,
        text: `Du bist erfolgreich für den Termin "${termin.titel}" am ${termin.datum} von ${termin.beginn} bis ${termin.ende} angemeldet. Vielen Dank!`
      }).then(() => {
        console.log('Bestätigungsmail erfolgreich versendet!');
      }).catch(error => {
        console.error('Mailversand fehlgeschlagen!');
        if (error.response) {
          console.error('Status:', error.response.statusCode);
          console.error('Body:', error.response.body);
        }
        console.error('Fehlerobjekt:', error);
        console.log('SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'gesetzt' : 'NICHT gesetzt');
        console.log('MAIL_FROM:', process.env.MAIL_FROM);
      });
    }

    res.json({ message: 'Teilnahme gespeichert und Bestätigungsmail versendet (oder Fehler geloggt)' });
  } catch (err) {
    console.error('[Teilnahme] Fehler:', err);
    if (err.stack) console.error(err.stack);
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
    console.log(`[Teilnahme] User ${username} von Termin ${termin_id} entfernt`);
    res.json({ message: 'Teilnahme entfernt' });
  } catch (err) {
    console.error('[Teilnahme] Fehler beim Entfernen:', err);
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
    console.log(`[Teilnehmer] Termin ${termin_id}:`, result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error('[Teilnehmer] Fehler:', err);
    res.status(500).json({ message: 'Fehler beim Laden der Teilnehmer', error: err.message });
  }
});

// --- (Stichtags-Mail & automatische Zuweisung am Stichtag wie gehabt) ---

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});