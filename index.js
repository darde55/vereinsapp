require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const { Resend } = require('resend');
const { createEvent } = require('ics');
const { DateTime } = require('luxon');
const cron = require('node-cron');
const ExcelJS = require('exceljs');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

console.log('===== ENV Logging =====');
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'gesetzt' : 'NICHT gesetzt');
console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'gesetzt' : 'NICHT gesetzt');
console.log('JWT_SECRET:', process.env.JWT_SECRET);
console.log('PORT:', PORT);
console.log('MAIL_FROM:', process.env.MAIL_FROM);
console.log('=======================');

// SendGrid Setup (optional)
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("SendGrid API Key ist gesetzt.");
}

// Resend Setup (kostenlose Alternative)
let resend = null;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log("Resend API Key ist gesetzt.");
}

if (!process.env.SENDGRID_API_KEY && !process.env.RESEND_API_KEY) {
  console.error("Weder SendGrid noch Resend API Key gesetzt! E-Mail-Versand deaktiviert.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureUsersVisibleColumn() {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS visible BOOLEAN DEFAULT TRUE');
    console.log('✅ Spalte users.visible bereit.');
  } catch (err) {
    console.error('❌ Fehler beim Anlegen der Spalte users.visible:', err.message);
  }
}

async function ensureZufallPoolTable() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS termin_zufall_pool (
        termin_id INTEGER REFERENCES termine(id) ON DELETE CASCADE,
        username TEXT REFERENCES users(username) ON DELETE CASCADE,
        PRIMARY KEY (termin_id, username)
      )`
    );
    console.log('✅ Tabelle termin_zufall_pool bereit.');
  } catch (err) {
    console.error('❌ Fehler beim Erstellen der Tabelle termin_zufall_pool:', err.message);
  }
}

async function ensureScoreHistoryTable() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS score_history (
        id SERIAL PRIMARY KEY,
        username TEXT REFERENCES users(username) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        termin_id INTEGER REFERENCES termine(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`
    );
    console.log('✅ Tabelle score_history bereit.');
  } catch (err) {
    console.error('❌ Fehler beim Erstellen der Tabelle score_history:', err.message);
  }
}

async function logScoreChange(username, delta, reason, terminId = null, client = pool) {
  if (!delta) return;
  try {
    await client.query(
      'INSERT INTO score_history (username, delta, reason, termin_id) VALUES ($1, $2, $3, $4)',
      [username, delta, reason, terminId]
    );
  } catch (err) {
    console.error('❌ Fehler beim Loggen der Score-Änderung:', err.message);
  }
}

ensureZufallPoolTable();
ensureUsersVisibleColumn();
ensureScoreHistoryTable();

// Universelle E-Mail-Funktion (unterstützt SendGrid und Resend)
async function sendEmail({ to, from, subject, text, html, attachments }) {
  console.log('📧 sendEmail aufgerufen:', { to, from, subject, hasAttachments: !!attachments });
  
  // Versuche Resend (kostenlos)
  if (resend) {
    try {
      const icsAttachment = attachments && attachments[0];
      console.log('📎 ICS Attachment vorhanden:', !!icsAttachment);
      
      const emailData = {
        from: from,
        to: [to],
        subject: subject,
        html: html || text,
      };
      
      if (icsAttachment) {
        // Resend erwartet content als Buffer oder String, nicht base64
        const icsContent = Buffer.from(icsAttachment.content, 'base64').toString('utf-8');
        console.log('📎 ICS Content Länge:', icsContent.length, 'Zeichen');
        console.log('📎 ICS Content Vorschau:', icsContent.substring(0, 100));
        
        emailData.attachments = [{
          filename: icsAttachment.filename || 'termin.ics',
          content: icsContent,
        }];
        console.log('📎 Attachment hinzugefügt zu emailData');
      }
      
      console.log('📧 Sende E-Mail via Resend mit Attachments:', !!emailData.attachments);
      const result = await resend.emails.send(emailData);
      console.log(`✅ E-Mail via Resend versendet an ${to}`, result);
      return { success: true, provider: 'resend' };
    } catch (error) {
      console.error('❌ Resend Fehler:', error);
      // Fallback zu SendGrid
    }
  }
  
  // Fallback: SendGrid
  if (process.env.SENDGRID_API_KEY) {
    try {
      console.log('📧 Versuche SendGrid als Fallback');
      await sgMail.send({ to, from, subject, text, html, attachments });
      console.log(`✅ E-Mail via SendGrid versendet an ${to}`);
      return { success: true, provider: 'sendgrid' };
    } catch (error) {
      console.error('❌ SendGrid Fehler:', error);
      throw error;
    }
  }
  
  throw new Error('Kein E-Mail-Provider konfiguriert');
}

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

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin-Rechte erforderlich' });
  }
  next();
}

function requireOrganizerOrAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'organisator')) {
    return res.status(403).json({ message: 'Admin- oder Organisator-Rechte erforderlich' });
  }
  next();
}

// --- Kiosk-Modul einbinden ---
const kioskRoutes = require('./kiosk')(pool, authenticateToken);
app.use('/api/kiosk', kioskRoutes);

// --- Healthcheck ---
app.get('/api/ping', (req, res) => {
  res.json({ message: 'pong' });
});

// --- Registrierung ---
app.post('/api/register', async (req, res) => {
  const { username, email, password, role, visible } = req.body;
  if (!username || !email || !password || !role) {
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password, role, score, visible) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, email, hashedPassword, role, 0, visible !== false]
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
      'SELECT username, email, role, score, visible FROM users WHERE LOWER(username) = LOWER($1)',
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
      score: user.score != null ? user.score : 0,
      visible: user.visible !== false
    });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden des Profils', error: err.message });
  }
});

// --- Score-Historie (User) ---
app.get('/api/profile/score-history', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await pool.query(
      `SELECT sh.delta, sh.reason, sh.created_at, t.titel AS termin_titel
       FROM score_history sh
       LEFT JOIN termine t ON t.id = sh.termin_id
       WHERE sh.username = $1
       ORDER BY sh.created_at DESC`,
      [username]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Score-Historie', error: err.message });
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

// --- Aktive Termine eines Users (für Tausch) ---
app.get('/api/users/:username/termine/aktiv', authenticateToken, async (req, res) => {
  const username = req.params.username;
  try {
    const result = await pool.query(
      `SELECT t.id, t.titel, t.datum, t.beginn, t.ende
       FROM termine t
       JOIN teilnahmen tn ON t.id = tn.termin_id
       WHERE tn.username = $1
       AND t.datum >= CURRENT_DATE
       ORDER BY t.datum ASC`,
      [username]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der User-Termine', error: err.message });
  }
});

// --- Benutzerverwaltung (Admin) ---
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT username, email, role, score, visible FROM users');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Benutzer', error: err.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  const { username, email, password, role, visible } = req.body;
  if (!username || !email || !password || !role) {
    return res.status(400).json({ message: 'Fehlende Felder!' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password, role, score, visible) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, email, hashedPassword, role, 0, visible !== false]
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

// --- Scores zurücksetzen (Admin) ---
app.post('/api/scores/reset', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usersRes = await pool.query('SELECT username, score FROM users');
    await pool.query('UPDATE users SET score = 0');
    for (const u of usersRes.rows) {
      const delta = -(u.score ?? 0);
      await logScoreChange(u.username, delta, 'Saison-Reset');
    }
    res.json({ message: 'Scores aller User wurden auf 0 gesetzt.' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Zurücksetzen der Scores', error: err.message });
  }
});

app.put('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;
  const { email, role, score, visible } = req.body;
  try {
    const currentScoreRes = await pool.query('SELECT score FROM users WHERE username = $1', [username]);
    const currentScore = currentScoreRes.rows[0]?.score ?? 0;
    const result = await pool.query(
      'UPDATE users SET email=$1, role=$2, score=$3, visible=$4 WHERE username=$5 RETURNING *',
      [email, role, score, visible !== false, username]
    );
    const delta = (score ?? 0) - (currentScore ?? 0);
    await logScoreChange(username, delta, 'Admin-Änderung');
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

// --- Termine als Excel exportieren (Admin/Organisator) ---
app.get('/api/termine/export/excel', authenticateToken, requireOrganizerOrAdmin, async (req, res) => {
  try {
    const { kategorie, von, bis } = req.query;
    const hasKategorie = typeof kategorie === 'string' && kategorie.trim() !== '';
    const hasVon = typeof von === 'string' && von.trim() !== '';
    const hasBis = typeof bis === 'string' && bis.trim() !== '';
    const result = await pool.query(
      `SELECT t.*, COALESCE(array_agg(tn.username) FILTER (WHERE tn.username IS NOT NULL), '{}') AS teilnehmer
       FROM termine t
       LEFT JOIN teilnahmen tn ON tn.termin_id = t.id
       WHERE ($1::text IS NULL OR t.kategorie = $1)
         AND ($2::date IS NULL OR t.datum >= $2::date)
         AND ($3::date IS NULL OR t.datum <= $3::date)
       GROUP BY t.id
       ORDER BY t.datum ASC`,
      [hasKategorie ? kategorie : null, hasVon ? von : null, hasBis ? bis : null]
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Termine');

    worksheet.columns = [
      { header: 'Titel', key: 'titel', width: 30 },
      { header: 'Datum', key: 'datum', width: 15 },
      { header: 'Beginn', key: 'beginn', width: 10 },
      { header: 'Ende', key: 'ende', width: 10 },
      { header: 'Kategorie', key: 'kategorie', width: 15 },
      { header: 'Anzahl', key: 'anzahl', width: 10 },
      { header: 'Teilnehmer', key: 'teilnehmer', width: 50 }
    ];

    for (const termin of result.rows) {
      worksheet.addRow({
        titel: termin.titel,
        datum: termin.datum ? String(termin.datum).split('T')[0] : '',
        beginn: termin.beginn || '',
        ende: termin.ende || '',
        kategorie: termin.kategorie || '',
        anzahl: termin.anzahl ?? '',
        teilnehmer: Array.isArray(termin.teilnehmer) ? termin.teilnehmer.join(', ') : ''
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const suffix = hasKategorie ? `_${String(kategorie).toLowerCase()}` : '';
    const dateSuffix = `${hasVon ? `_von-${String(von)}` : ''}${hasBis ? `_bis-${String(bis)}` : ''}`;
    res.setHeader('Content-Disposition', `attachment; filename="termine_export${suffix}${dateSuffix}_${today}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Excel-Export', error: err.message });
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const terminRes = await client.query('SELECT * FROM termine WHERE id = $1', [termin_id]);
    if (terminRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Termin nicht gefunden' });
    }
    const termin = terminRes.rows[0];
    const terminScore = typeof termin.score === "number" ? termin.score : 0;

    const teilnehmerRes = await client.query(
      'SELECT username FROM teilnahmen WHERE termin_id = $1',
      [termin_id]
    );
    const teilnehmer = teilnehmerRes.rows.map(r => r.username);
    if (teilnehmer.length > 0 && terminScore !== 0) {
      await client.query(
        'UPDATE users SET score = score - $1 WHERE username = ANY($2)',
        [terminScore, teilnehmer]
      );
      for (const username of teilnehmer) {
        await logScoreChange(username, -terminScore, 'Termin gelöscht', termin_id, client);
      }
    }

    await client.query('DELETE FROM teilnahmen WHERE termin_id = $1', [termin_id]);
    const result = await client.query('DELETE FROM termine WHERE id = $1 RETURNING *', [termin_id]);
    await client.query('COMMIT');
    res.json({ message: 'Termin gelöscht', termin: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Fehler beim Löschen des Termins', error: err.message });
  } finally {
    client.release();
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

    // --- Score des Termins holen und zum User-Score addieren ---
    const terminScoreRes = await pool.query(
      'SELECT score FROM termine WHERE id = $1',
      [termin_id]
    );
    const terminScore = (terminScoreRes.rows[0] && typeof terminScoreRes.rows[0].score === "number")
      ? terminScoreRes.rows[0].score
      : 0;
    await pool.query(
      'UPDATE users SET score = score + $1 WHERE username = $2',
      [terminScore, username]
    );
    await logScoreChange(username, terminScore, 'Anmeldung Termin', termin_id);

    // --- Email-Funktion: schicke E-Mail an User mit ICS (Luxon Fix) ---
    if ((process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY) && process.env.MAIL_FROM) {
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

        try {
          let datumStr = "";
          if (typeof termin.datum === "string") {
            datumStr = termin.datum.split('T')[0];
          } else {
            datumStr = new Date(termin.datum).toISOString().split('T')[0];
          }
          const [year, month, day] = datumStr.split('-').map(Number);
          const [startHour, startMinute] = (termin.beginn || '09:00').split(':').map(Number);
          const [endHour, endMinute] = (termin.ende || '10:00').split(':').map(Number);

          // Luxon: Sicher korrekte Zeitzone Europe/Berlin
          const startBerlin = DateTime.fromObject(
            { year, month, day, hour: startHour, minute: startMinute },
            { zone: 'Europe/Berlin' }
          );
          const endBerlin = DateTime.fromObject(
            { year, month, day, hour: endHour, minute: endMinute },
            { zone: 'Europe/Berlin' }
          );

          // Validiere E-Mail für Organizer (ICS erfordert valide E-Mail)
          const isValidEmail = (email) => {
            if (!email) return false;
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
          };

          const organizerEmail = isValidEmail(termin.ansprechpartner_mail) 
            ? termin.ansprechpartner_mail 
            : process.env.MAIL_FROM || 'noreply@example.com';

          // Übergebe an ICS UTC, somit TZID funktioniert in Kalendern
          const icsEvent = {
            start: [
              startBerlin.toUTC().year,
              startBerlin.toUTC().month,
              startBerlin.toUTC().day,
              startBerlin.toUTC().hour,
              startBerlin.toUTC().minute
            ],
            end: [
              endBerlin.toUTC().year,
              endBerlin.toUTC().month,
              endBerlin.toUTC().day,
              endBerlin.toUTC().hour,
              endBerlin.toUTC().minute
            ],
            title: termin.titel,
            description: termin.beschreibung || "",
            location: "",
            status: 'CONFIRMED',
            organizer: { name: termin.ansprechpartner_name || "TSV Wolfschlugen", email: organizerEmail }
          };

          console.log('🗓️ Erstelle ICS-Event:', icsEvent);
          createEvent(icsEvent, async (error, value) => {
            console.log('🗓️ createEvent Callback:', { error: !!error, hasValue: !!value });
            if (error) {
              console.error('❌ ICS Erstellungsfehler:', error);
            }
            if (error || !value) {
              try {
                console.log('📧 Sende Mail ohne ICS (createEvent Fehler)');
                await sendEmail(mailMsg);
                res.json({ message: 'Teilnahme gespeichert. (Mail ohne ICS versendet)', icsError: error });
              } catch (sendError) {
                res.status(500).json({ message: 'Fehler beim Senden der Mail ohne ICS', detail: sendError });
              }
              return;
            }
            // VTIMEZONE-Block für Berlin ergänzen:
            let valueWithTz = value
              .replace(/DTSTART:(\d{8}T\d{6})/g, 'DTSTART;TZID=Europe/Berlin:$1')
              .replace(/DTEND:(\d{8}T\d{6})/g, 'DTEND;TZID=Europe/Berlin:$1');
            valueWithTz =
              "BEGIN:VTIMEZONE\n" +
              "TZID:Europe/Berlin\n" +
              "BEGIN:STANDARD\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nDTSTART:19701025T030000\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\nEND:STANDARD\n" +
              "BEGIN:DAYLIGHT\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nDTSTART:19700329T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\nEND:VTIMEZONE\n" +
              valueWithTz;

            console.log('✅ ICS erstellt, Länge:', valueWithTz.length);
            mailMsg.attachments = [{
              content: Buffer.from(valueWithTz).toString('base64'),
              filename: 'termin.ics',
              type: 'text/calendar',
              disposition: 'attachment'
            }];
            console.log('📎 Attachment zu mailMsg hinzugefügt');
            try {
              await sendEmail(mailMsg);
              res.json({ message: 'Teilnahme gespeichert. (Mail inkl. ICS versendet)' });
            } catch (sendError) {
              res.status(500).json({ message: 'Fehler beim Senden der Mail', detail: sendError });
            }
          });
        } catch (err) {
          console.error('❌ Fehler im Try-Block:', err);
          try {
            await sendEmail(mailMsg);
            res.json({ message: 'Teilnahme gespeichert. (Mail ohne ICS versendet, Fehler im Datum)', icsError: err });
          } catch (sendError) {
            res.status(500).json({ message: 'Fehler beim Senden der Mail ohne ICS', detail: sendError });
          }
        }
        return;
      }
    }

    res.json({ message: 'Teilnahme gespeichert.' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler bei Teilnahme', error: err.message });
  }
});

// --- Tauschpartner: Teilnehmer ersetzen ---
app.post('/api/termine/:id/tausch', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const fromUsername = req.user.username;
  const { newUsername } = req.body;
  if (!newUsername || typeof newUsername !== 'string') {
    return res.status(400).json({ message: 'newUsername fehlt' });
  }
  if (newUsername === fromUsername) {
    return res.status(400).json({ message: 'Tauschpartner muss ein anderer User sein' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const terminRes = await client.query('SELECT score FROM termine WHERE id = $1', [termin_id]);
    if (terminRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Termin nicht gefunden' });
    }
    const terminScore = typeof terminRes.rows[0].score === "number" ? terminRes.rows[0].score : 0;

    const checkFrom = await client.query(
      'SELECT 1 FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, fromUsername]
    );
    if (checkFrom.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Du bist für diesen Termin nicht angemeldet' });
    }

    const checkTo = await client.query(
      'SELECT 1 FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, newUsername]
    );
    if (checkTo.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'User ist bereits angemeldet' });
    }

    await client.query(
      'DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, fromUsername]
    );
    await client.query(
      'UPDATE users SET score = score - $1 WHERE username = $2',
      [terminScore, fromUsername]
    );
    await logScoreChange(fromUsername, -terminScore, 'Tausch (Abgabe)', termin_id, client);

    await client.query(
      'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)',
      [termin_id, newUsername]
    );
    await client.query(
      'UPDATE users SET score = score + $1 WHERE username = $2',
      [terminScore, newUsername]
    );
    await logScoreChange(newUsername, terminScore, 'Tausch (Übernahme)', termin_id, client);

    await client.query('COMMIT');
    res.json({ message: 'Tausch erfolgreich', from: fromUsername, to: newUsername });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Fehler beim Tauschen', error: err.message });
  } finally {
    client.release();
  }
});

// --- Termin-zu-Termin-Tausch ---
app.post('/api/termine/tausch/termin-zu-termin', authenticateToken, async (req, res) => {
  const { partnerUsername, eigenerTerminId, partnerTerminId } = req.body;
  const currentUsername = req.user.username;
  if (!partnerUsername || !eigenerTerminId) {
    return res.status(400).json({ message: 'partnerUsername und eigenerTerminId sind erforderlich' });
  }
  if (partnerUsername === currentUsername) {
    return res.status(400).json({ message: 'Partner muss ein anderer User sein' });
  }
  if (partnerTerminId && Number(eigenerTerminId) === Number(partnerTerminId)) {
    return res.status(400).json({ message: 'Termine müssen unterschiedlich sein' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ownCheck = await client.query(
      'SELECT 1 FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [eigenerTerminId, currentUsername]
    );
    if (ownCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Du bist für deinen Termin nicht angemeldet' });
    }

    const ownTerminRes = await client.query('SELECT score FROM termine WHERE id = $1', [eigenerTerminId]);
    if (ownTerminRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Termin nicht gefunden' });
    }
    const ownScore = typeof ownTerminRes.rows[0].score === 'number' ? ownTerminRes.rows[0].score : 0;

    if (partnerTerminId) {
      const partnerCheck = await client.query(
        'SELECT 1 FROM teilnahmen WHERE termin_id = $1 AND username = $2',
        [partnerTerminId, partnerUsername]
      );
      if (partnerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Partner ist für den Termin nicht angemeldet' });
      }

      const partnerTerminRes = await client.query('SELECT score FROM termine WHERE id = $1', [partnerTerminId]);
      if (partnerTerminRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Termin nicht gefunden' });
      }
      const partnerScore = typeof partnerTerminRes.rows[0].score === 'number' ? partnerTerminRes.rows[0].score : 0;

      await client.query('DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2', [eigenerTerminId, currentUsername]);
      await client.query('DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2', [partnerTerminId, partnerUsername]);

      await client.query('INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)', [eigenerTerminId, partnerUsername]);
      await client.query('INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)', [partnerTerminId, currentUsername]);

      await client.query('UPDATE users SET score = score - $1 + $2 WHERE username = $3', [ownScore, partnerScore, currentUsername]);
      await client.query('UPDATE users SET score = score - $1 + $2 WHERE username = $3', [partnerScore, ownScore, partnerUsername]);

      await logScoreChange(currentUsername, -ownScore, 'Tausch (Abgabe)', eigenerTerminId, client);
      await logScoreChange(currentUsername, partnerScore, 'Tausch (Übernahme)', partnerTerminId, client);
      await logScoreChange(partnerUsername, -partnerScore, 'Tausch (Abgabe)', partnerTerminId, client);
      await logScoreChange(partnerUsername, ownScore, 'Tausch (Übernahme)', eigenerTerminId, client);

      await client.query('COMMIT');
      res.json({ message: 'Termin-Tausch erfolgreich', partnerUsername, eigenerTerminId, partnerTerminId });
      return;
    }

    await client.query('DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2', [eigenerTerminId, currentUsername]);
    await client.query('UPDATE users SET score = score - $1 WHERE username = $2', [ownScore, currentUsername]);
    await logScoreChange(currentUsername, -ownScore, 'Termin übertragen (Abgabe)', eigenerTerminId, client);

    await client.query('INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)', [eigenerTerminId, partnerUsername]);
    await client.query('UPDATE users SET score = score + $1 WHERE username = $2', [ownScore, partnerUsername]);
    await logScoreChange(partnerUsername, ownScore, 'Termin übertragen (Übernahme)', eigenerTerminId, client);

    await client.query('COMMIT');
    res.json({ message: 'Termin übertragen', partnerUsername, eigenerTerminId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Fehler beim Termin-Tausch', error: err.message });
  } finally {
    client.release();
  }
});

// --- User trägt sich aus Termin aus ---
app.delete('/api/termine/:id/teilnehmen', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.user.username;
  try {
    const terminScoreRes = await pool.query(
      'SELECT score FROM termine WHERE id = $1',
      [termin_id]
    );
    const terminScore = (terminScoreRes.rows[0] && typeof terminScoreRes.rows[0].score === "number")
      ? terminScoreRes.rows[0].score
      : 0;

    await pool.query(
      'DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, username]
    );

    await pool.query(
      'UPDATE users SET score = score - $1 WHERE username = $2',
      [terminScore, username]
    );
    await logScoreChange(username, -terminScore, 'Abmeldung Termin', termin_id);

    res.json({ message: 'Teilnahme entfernt & Score abgezogen' });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Entfernen der Teilnahme', error: err.message });
  }
});

// --- Admin entfernt Teilnehmer von Termin ---
app.delete('/api/termine/:id/teilnehmer/:username', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.params.username;
  try {
    const terminScoreRes = await pool.query(
      'SELECT score FROM termine WHERE id = $1',
      [termin_id]
    );
    const terminScore = (terminScoreRes.rows[0] && typeof terminScoreRes.rows[0].score === "number")
      ? terminScoreRes.rows[0].score
      : 0;

    await pool.query(
      'DELETE FROM teilnahmen WHERE termin_id = $1 AND username = $2',
      [termin_id, username]
    );

    await pool.query(
      'UPDATE users SET score = score - $1 WHERE username = $2',
      [terminScore, username]
    );
    await logScoreChange(username, -terminScore, 'Admin entfernt Teilnahme', termin_id);

    res.json({ message: `Teilnehmer ${username} von Termin ${termin_id} entfernt & Score abgezogen.` });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Entfernen des Teilnehmers', error: err.message });
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

// --- Zufallsauswahl-Pool für Termin (Admin) ---
app.get('/api/termine/:id/zufallspool', authenticateToken, requireAdmin, async (req, res) => {
  const termin_id = req.params.id;
  try {
    const result = await pool.query(
      'SELECT username FROM termin_zufall_pool WHERE termin_id = $1 ORDER BY username ASC',
      [termin_id]
    );
    res.json({ usernames: result.rows.map(r => r.username) });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden des Zufallspools', error: err.message });
  }
});

app.put('/api/termine/:id/zufallspool', authenticateToken, requireAdmin, async (req, res) => {
  const termin_id = req.params.id;
  const { usernames } = req.body;
  if (!Array.isArray(usernames)) {
    return res.status(400).json({ message: 'usernames muss ein Array sein' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM termin_zufall_pool WHERE termin_id = $1', [termin_id]);
    for (const username of usernames) {
      await client.query(
        'INSERT INTO termin_zufall_pool (termin_id, username) VALUES ($1, $2)',
        [termin_id, username]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Zufallspool gespeichert', count: usernames.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Fehler beim Speichern des Zufallspools', error: err.message });
  } finally {
    client.release();
  }
});

// --- Zufallsauswahl starten (Admin) ---
app.post('/api/termine/:id/zufallsauswahl/start', authenticateToken, requireAdmin, async (req, res) => {
  const termin_id = req.params.id;
  const { usernames } = req.body;
  try {
    const terminRes = await pool.query('SELECT * FROM termine WHERE id = $1', [termin_id]);
    if (terminRes.rows.length === 0) {
      return res.status(404).json({ message: 'Termin nicht gefunden' });
    }
    const termin = terminRes.rows[0];
    if (!termin.anzahl || termin.anzahl <= 0) {
      return res.status(400).json({ message: 'Termin hat keine gültige Anzahl' });
    }

    const teilnahmenRes = await pool.query(
      'SELECT COUNT(*) as count FROM teilnahmen WHERE termin_id = $1',
      [termin_id]
    );
    const aktTeilnehmer = parseInt(teilnahmenRes.rows[0].count);
    const benoetigte = Math.max(termin.anzahl - aktTeilnehmer, 0);
    if (benoetigte === 0) {
      return res.json({ message: 'Termin bereits voll', zugeordnet: [], uebersprungen: [] });
    }

    let candidates = [];
    if (Array.isArray(usernames) && usernames.length > 0) {
      const usersRes = await pool.query(
        `SELECT username, email, score, role FROM users WHERE username = ANY($1)`,
        [usernames]
      );
      candidates = usersRes.rows.filter(u => u.role !== 'admin');
    } else {
      const poolRes = await pool.query(
        `SELECT u.username, u.email, u.score, u.role
         FROM users u
         WHERE u.role != 'admin'
         AND u.visible = true
         AND u.username NOT IN (
           SELECT username FROM teilnahmen WHERE termin_id = $1
         )
         AND (
           NOT EXISTS (SELECT 1 FROM termin_zufall_pool WHERE termin_id = $1)
           OR u.username IN (SELECT username FROM termin_zufall_pool WHERE termin_id = $1)
         )
         ORDER BY u.score ASC`,
        [termin_id]
      );
      candidates = poolRes.rows;
    }

    const groupedByScore = new Map();
    for (const user of candidates) {
      const score = typeof user.score === "number" ? user.score : 0;
      if (!groupedByScore.has(score)) groupedByScore.set(score, []);
      groupedByScore.get(score).push(user);
    }
    const sortedScores = Array.from(groupedByScore.keys()).sort((a, b) => a - b);
    const toAssign = [];
    for (const score of sortedScores) {
      const group = groupedByScore.get(score).sort(() => 0.5 - Math.random());
      for (const user of group) {
        if (toAssign.length >= benoetigte) break;
        toAssign.push(user);
      }
      if (toAssign.length >= benoetigte) break;
    }
    const skipped = candidates
      .filter(u => !toAssign.some(a => a.username === u.username))
      .map(u => u.username);
    const fehlend = Math.max(benoetigte - toAssign.length, 0);

    for (const user of toAssign) {
      const check = await pool.query(
        'SELECT 1 FROM teilnahmen WHERE termin_id = $1 AND username = $2',
        [termin_id, user.username]
      );
      if (check.rows.length > 0) continue;

      await pool.query(
        'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)',
        [termin_id, user.username]
      );

      await pool.query(
        'UPDATE users SET score = score + $1 WHERE username = $2',
        [termin.score || 0, user.username]
      );
      await logScoreChange(user.username, termin.score || 0, 'Zufallsauswahl (Cron)', termin.id);

      if ((process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY) && process.env.MAIL_FROM) {
        const mailMsg = {
          to: user.email,
          from: process.env.MAIL_FROM,
          subject: `Zufallsauswahl: Du wurdest für "${termin.titel}" ausgewählt`,
          text: `Hallo ${user.username},\n\ndu wurdest per Zufallsauswahl für den Termin "${termin.titel}" am ${termin.datum} ausgewählt.\n\nBitte melde dich bei Fragen beim Ansprechpartner: ${termin.ansprechpartner_name || 'N/A'} (${termin.ansprechpartner_mail || 'N/A'}).\n\nViele Grüße`,
          html: `<p>Hallo <b>${user.username}</b>,</p><p>du wurdest per <b>Zufallsauswahl</b> für den Termin <b>${termin.titel}</b> am <b>${termin.datum}</b> ausgewählt.</p><p>Bitte melde dich bei Fragen beim Ansprechpartner:<br>${termin.ansprechpartner_name || 'N/A'} (${termin.ansprechpartner_mail || 'N/A'})</p><p>Viele Grüße</p>`
        };
        try {
          await sendEmail(mailMsg);
        } catch (emailErr) {
          console.error(`❌ Fehler beim E-Mail-Versand an ${user.email}:`, emailErr.message);
        }
      }
    }

    res.json({
      message: fehlend > 0
        ? `Zufallsauswahl gestartet, es fehlen ${fehlend} Teilnehmer.`
        : 'Zufallsauswahl gestartet',
      zugeordnet: toAssign.map(u => u.username),
      uebersprungen: skipped,
      fehlend
    });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Start der Zufallsauswahl', error: err.message });
  }
});

// ========================================
// CRON JOB: Zufallsauswahl am Stichtag
// ========================================
// Läuft täglich um 08:00 Uhr
cron.schedule('0 8 * * *', async () => {
  console.log('🎲 Cron-Job gestartet: Prüfe Zufallsauswahl für heute...');
  
  try {
    const heute = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
    
    // Finde alle Termine mit Zufallsauswahl, deren Stichtag heute ist
    const termineRes = await pool.query(
      `SELECT * FROM termine 
       WHERE zufallsauswahl = true 
       AND DATE(stichtag) = $1
       AND datum >= CURRENT_DATE`,
      [heute]
    );
    
    if (termineRes.rows.length === 0) {
      console.log('✅ Keine Termine mit Zufallsauswahl für heute gefunden.');
      return;
    }
    
    console.log(`📋 ${termineRes.rows.length} Termin(e) mit Zufallsauswahl gefunden.`);
    
    for (const termin of termineRes.rows) {
      console.log(`\n🎯 Verarbeite Termin: ${termin.titel} (ID: ${termin.id})`);
      
      // Prüfe, wie viele Teilnehmer bereits angemeldet sind
      const teilnahmenRes = await pool.query(
        'SELECT COUNT(*) as count FROM teilnahmen WHERE termin_id = $1',
        [termin.id]
      );
      const aktTeilnehmer = parseInt(teilnahmenRes.rows[0].count);
      if (!termin.anzahl || termin.anzahl <= 0) {
        console.log(`⏭️  Termin ohne gültige Anzahl (ID: ${termin.id})`);
        continue;
      }
      const benoetigte = termin.anzahl - aktTeilnehmer;
      
      if (benoetigte <= 0) {
        console.log(`⏭️  Termin bereits voll (${aktTeilnehmer}/${termin.anzahl})`);
        continue;
      }
      
      console.log(`📊 Benötigte Teilnehmer: ${benoetigte} (aktuell: ${aktTeilnehmer}/${termin.anzahl})`);
      
      // Hole User aus dem Zufallspool (falls vorhanden), sonst alle Nicht-Admins
      const poolRes = await pool.query(
        `SELECT u.username, u.email, u.score 
         FROM users u
         WHERE u.role != 'admin'
         AND u.visible = true
         AND u.username NOT IN (
           SELECT username FROM teilnahmen WHERE termin_id = $1
         )
         AND (
           NOT EXISTS (SELECT 1 FROM termin_zufall_pool WHERE termin_id = $1)
           OR u.username IN (SELECT username FROM termin_zufall_pool WHERE termin_id = $1)
         )
         ORDER BY u.score ASC`,
        [termin.id]
      );
      
      if (poolRes.rows.length === 0) {
        console.log('❌ Keine verfügbaren User im Pool.');
        continue;
      }
      
      // Bevorzuge niedrigere Scores: erst niedrige Scores, Zufall nur innerhalb gleicher Scores
      const groupedByScore = new Map();
      for (const user of poolRes.rows) {
        const score = typeof user.score === "number" ? user.score : 0;
        if (!groupedByScore.has(score)) groupedByScore.set(score, []);
        groupedByScore.get(score).push(user);
      }
      const sortedScores = Array.from(groupedByScore.keys()).sort((a, b) => a - b);
      const ausgewaehlt = [];
      for (const score of sortedScores) {
        const group = groupedByScore.get(score).sort(() => 0.5 - Math.random());
        for (const user of group) {
          if (ausgewaehlt.length >= benoetigte) break;
          ausgewaehlt.push(user);
        }
        if (ausgewaehlt.length >= benoetigte) break;
      }
      
      const minScore = sortedScores[0];
      console.log(`🎱 User-Pool mit niedrigem Score ${minScore}: ${groupedByScore.get(minScore).length} User`);
      
      console.log(`✅ Ausgewählt: ${ausgewaehlt.map(u => u.username).join(', ')}`);
      
      // User zu Termin hinzufügen und Score aktualisieren
      for (const user of ausgewaehlt) {
        await pool.query(
          'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2)',
          [termin.id, user.username]
        );
        
        await pool.query(
          'UPDATE users SET score = score + $1 WHERE username = $2',
          [termin.score || 0, user.username]
        );
        await logScoreChange(user.username, termin.score || 0, 'Zufallsauswahl (Start)', termin.id);
        
        console.log(`  ✓ ${user.username} hinzugefügt (Score +${termin.score || 0})`);
        
        // E-Mail an User senden
        if ((process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY) && process.env.MAIL_FROM) {
          const mailMsg = {
            to: user.email,
            from: process.env.MAIL_FROM,
            subject: `Zufallsauswahl: Du wurdest für "${termin.titel}" ausgewählt`,
            text: `Hallo ${user.username},\n\ndu wurdest per Zufallsauswahl für den Termin "${termin.titel}" am ${termin.datum} ausgewählt.\n\nBitte melde dich bei Fragen beim Ansprechpartner: ${termin.ansprechpartner_name || 'N/A'} (${termin.ansprechpartner_mail || 'N/A'}).\n\nViele Grüße`,
            html: `<p>Hallo <b>${user.username}</b>,</p><p>du wurdest per <b>Zufallsauswahl</b> für den Termin <b>${termin.titel}</b> am <b>${termin.datum}</b> ausgewählt.</p><p>Bitte melde dich bei Fragen beim Ansprechpartner:<br>${termin.ansprechpartner_name || 'N/A'} (${termin.ansprechpartner_mail || 'N/A'})</p><p>Viele Grüße</p>`
          };
          
          try {
            await sendEmail(mailMsg);
            console.log(`  📧 E-Mail an ${user.email} gesendet`);
          } catch (emailErr) {
            console.error(`  ❌ Fehler beim E-Mail-Versand an ${user.email}:`, emailErr.message);
          }
        }
      }
    }
    
    console.log('\n✅ Cron-Job abgeschlossen.\n');
  } catch (err) {
    console.error('❌ Fehler im Zufallsauswahl-Cron-Job:', err);
  }
}, {
  timezone: "Europe/Berlin"
});

console.log('⏰ Cron-Job für Zufallsauswahl aktiv (täglich 08:00 Uhr Europe/Berlin)');

// --- Serverstart ---
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});