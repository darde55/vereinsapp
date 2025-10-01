require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const cron = require('node-cron');
const { createEvent } = require('ics');
const app = express();

const PORT = process.env.PORT || 8080;

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

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token fehlt' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Token ungültig', error: err.message });
  }
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
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Passwort falsch' });
    }

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

// --- Profil (geschützt) für Dashboard ---
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await pool.query(
      'SELECT username, email, role, score FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: `User ${username} nicht gefunden` });
    }
    const user = result.rows[0];
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

// --- Passwort ändern (geschützt für User/Admin) ---
app.post('/api/profile/password', authenticateToken, async (req, res) => {
  const username = req.user.username;
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: "Bitte altes und neues Passwort angeben." });
  }
  try {
    const result = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User nicht gefunden." });
    }
    const user = result.rows[0];
    const pwOk = await bcrypt.compare(oldPassword, user.password);
    if (!pwOk) {
      return res.status(403).json({ message: "Altes Passwort ist falsch." });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashed, username]);
    res.json({ message: "Passwort erfolgreich geändert." });
  } catch (err) {
    res.status(500).json({ message: "Fehler beim Passwortwechsel.", error: err.message });
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
    await pool.query('DELETE FROM teilnahmen WHERE username = $1', [username]);
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ message: 'Benutzer gelöscht' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Löschen des Benutzers', error: err.message });
  }
});

// --- Termine mit Teilnehmern ---
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

// --- Termin anlegen ---
app.post('/api/termine', authenticateToken, async (req, res) => {
  const {
    titel, beschreibung, datum, beginn, ende, anzahl, stichtag,
    ansprechpartner_name, ansprechpartner_mail, score,
    stichtagsmail_senden, zufallsauswahl, kategorie
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO termine (titel, beschreibung, datum, beginn, ende, anzahl, stichtag, ansprechpartner_name, ansprechpartner_mail, score, stichtagsmail_senden, zufallsauswahl, kategorie)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        titel, beschreibung, datum, beginn, ende, anzahl, stichtag,
        ansprechpartner_name, ansprechpartner_mail, score || 0,
        stichtagsmail_senden || false, zufallsauswahl || false, kategorie || "Sonstiges"
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Anlegen des Termins', error: err.message });
  }
});

// --- Termin bearbeiten ---
app.put('/api/termine/:id', authenticateToken, async (req, res) => {
  const id = req.params.id;
  const {
    titel, beschreibung, datum, beginn, ende, anzahl, stichtag,
    ansprechpartner_name, ansprechpartner_mail, score,
    stichtagsmail_senden, zufallsauswahl, kategorie
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE termine SET titel=$1, beschreibung=$2, datum=$3, beginn=$4, ende=$5, anzahl=$6, stichtag=$7, ansprechpartner_name=$8, ansprechpartner_mail=$9, score=$10, stichtagsmail_senden=$11, zufallsauswahl=$12, kategorie=$13
      WHERE id=$14 RETURNING *`,
      [
        titel, beschreibung, datum, beginn, ende, anzahl, stichtag,
        ansprechpartner_name, ansprechpartner_mail, score || 0,
        stichtagsmail_senden || false, zufallsauswahl || false, kategorie || "Sonstiges", id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Bearbeiten des Termins', error: err.message });
  }
});

// --- Termin löschen (Admin) ---
app.delete('/api/termine/:id', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  try {
    await pool.query('DELETE FROM teilnahmen WHERE termin_id = $1', [termin_id]);
    const result = await pool.query('DELETE FROM termine WHERE id = $1 RETURNING *', [termin_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Termin nicht gefunden' });
    }
    res.json({ message: 'Termin gelöscht', termin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Löschen des Termins', error: err.message });
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

    // --- Email-Funktion: schicke E-Mail an User mit ICS ---
    if (process.env.SENDGRID_API_KEY && process.env.MAIL_FROM) {
      const userResult = await pool.query('SELECT email FROM users WHERE username = $1', [username]);
      if (userResult.rows.length > 0) {
        const userMail = userResult.rows[0].email;
        const terminResult = await pool.query('SELECT * FROM termine WHERE id = $1', [termin_id]);
        const termin = terminResult.rows[0];
        const mailMsg = {
          to: userMail,
          from: process.env.MAIL_FROM,
          subject: `Anmeldung für Termin "${termin.titel}"`,
          text: `Du bist für den Termin "${termin.titel}" am ${termin.datum} angemeldet.`,
          html: `<p>Du bist für den Termin <b>${termin.titel}</b> am <b>${termin.datum}</b> angemeldet.</p>`
        };

        // ICS erstellen und anhängen
        const [year, month, day] = termin.datum.split('-').map(Number);
        const [startHour, startMinute] = (termin.beginn || '09:00').split(':').map(Number);
        const [endHour, endMinute] = (termin.ende || '10:00').split(':').map(Number);

        const icsEvent = {
          start: [year, month, day, startHour, startMinute],
          end: [year, month, day, endHour, endMinute],
          title: termin.titel,
          description: termin.beschreibung || "",
          location: "",
          status: 'CONFIRMED',
          organizer: { name: termin.ansprechpartner_name || "", email: termin.ansprechpartner_mail || "" }
        };

        createEvent(icsEvent, (error, value) => {
          if (error) {
            console.error('Fehler beim Generieren der ICS-Datei:', error);
            sgMail.send(mailMsg);
            return;
          }
          mailMsg.attachments = [{
            content: Buffer.from(value).toString('base64'),
            filename: 'termin.ics',
            type: 'text/calendar',
            disposition: 'attachment'
          }];
          sgMail.send(mailMsg);
        });
      }
    }

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

// --- Teilnehmerliste für Termin ---
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

// --- Admin entfernt Teilnehmer von Termin ---
app.delete('/api/termine/:id/teilnehmer/:username', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.params.username;
  try {
    await pool.query(
      'DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, username]
    );
    res.json({ message: `Teilnehmer ${username} von Termin ${termin_id} entfernt.` });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Entfernen des Teilnehmers', error: err.message });
  }
});

// --- CRONJOB: Stichtagsmail & Zufallsauswahl ---
cron.schedule('0 2 * * *', async () => { // Täglich um 02:00 Uhr
  const heute = new Date().toISOString().slice(0, 10);
  try {
    // 1. Stichtagsmail senden
    const termineMail = await pool.query(
      "SELECT * FROM termine WHERE stichtagsmail_senden = true AND stichtag = $1",
      [heute]
    );
    for (const termin of termineMail.rows) {
      const teilnahmen = await pool.query(
        "SELECT username FROM teilnahmen WHERE termin_id = $1",
        [termin.id]
      );
      const userList = teilnahmen.rows.map(u => u.username).join(", ");
      if (termin.ansprechpartner_mail) {
        const mailMsg = {
          to: termin.ansprechpartner_mail,
          from: process.env.MAIL_FROM,
          subject: `Stichtagsmail für Termin "${termin.titel}"`,
          text: `Angemeldete Personen: ${userList}`,
          html: `<p>Angemeldete Personen für <b>${termin.titel}</b>:<br>${userList.replace(/, /g, "<br>")}</p>`
        };

        // ICS erstellen und anhängen
        const [year, month, day] = termin.datum.split('-').map(Number);
        const [startHour, startMinute] = (termin.beginn || '09:00').split(':').map(Number);
        const [endHour, endMinute] = (termin.ende || '10:00').split(':').map(Number);

        const icsEvent = {
          start: [year, month, day, startHour, startMinute],
          end: [year, month, day, endHour, endMinute],
          title: termin.titel,
          description: termin.beschreibung || "",
          location: "",
          status: 'CONFIRMED',
          organizer: { name: termin.ansprechpartner_name || "", email: termin.ansprechpartner_mail || "" }
        };

        createEvent(icsEvent, (error, value) => {
          if (!error && value) {
            mailMsg.attachments = [{
              content: Buffer.from(value).toString('base64'),
              filename: 'termin.ics',
              type: 'text/calendar',
              disposition: 'attachment'
            }];
          }
          sgMail.send(mailMsg);
        });
      }
    }

    // 2. Zufallsauswahl durchführen
    const termineZufall = await pool.query(
      "SELECT * FROM termine WHERE zufallsauswahl = true AND stichtag = $1",
      [heute]
    );
    for (const termin of termineZufall.rows) {
      const teilnahmen = await pool.query(
        "SELECT username FROM teilnahmen WHERE termin_id = $1",
        [termin.id]
      );
      const angemeldet = teilnahmen.rows.map(u => u.username);
      const rest = (termin.anzahl || 0) - angemeldet.length;
      if (rest > 0) {
        const alleUser = await pool.query(
          `SELECT username, score FROM users 
           WHERE username NOT IN (
             SELECT username FROM teilnahmen WHERE termin_id = $1
           ) ORDER BY score ASC`,
          [termin.id]
        );
        let kandidaten = [];
        if (alleUser.rows.length > 0) {
          const minScore = alleUser.rows[0].score;
          kandidaten = alleUser.rows.filter(u => u.score === minScore);
          let i = 1;
          while (kandidaten.length < rest && alleUser.rows[i]) {
            if (alleUser.rows[i].score > minScore) kandidaten.push(alleUser.rows[i]);
            i++;
          }
        }
        const shuffled = kandidaten.sort(() => 0.5 - Math.random());
        const zufallsUser = shuffled.slice(0, rest);
        for (const user of zufallsUser) {
          await pool.query(
            "INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)",
            [termin.id, user.username]
          );
        }
      }
    }
    console.log(`[CRON] Stichtagsmail/Zufallsauswahl am ${heute} durchgeführt.`);
  } catch (err) {
    console.error('[CRON] Fehler:', err);
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});