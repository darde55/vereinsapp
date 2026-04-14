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

ensureZufallPoolTable();

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

// --- Kiosk-Modul einbinden ---
const kioskRoutes = require('./kiosk')(pool, authenticateToken);
app.use('/api/kiosk', kioskRoutes);

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
      const benoetigte = (termin.anzahl || 0) - aktTeilnehmer;
      
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