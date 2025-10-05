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

// --- Robuste, einfache CORS-Konfiguration ---
app.use(cors()); // Erlaubt ALLES (ideal zum Testen/Debuggen, funktioniert garantiert auf Railway & Co.)
app.use(express.json());

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
            if (error || !value) {
              sgMail.send(mailMsg)
                .then(() => {
                  res.json({ message: 'Teilnahme gespeichert. (Mail ohne ICS versendet)', icsError: error });
                })
                .catch(sendError => {
                  res.status(500).json({ message: 'Fehler beim Senden der Mail ohne ICS', detail: sendError });
                });
              return;
            }
            let valueWithTz = value
              .replace(/DTSTART:(\d{8}T\d{6})/g, 'DTSTART;TZID=Europe/Berlin:$1')
              .replace(/DTEND:(\d{8}T\d{6})/g, 'DTEND;TZID=Europe/Berlin:$1');

            mailMsg.attachments = [{
              content: Buffer.from(valueWithTz).toString('base64'),
              filename: 'termin.ics',
              type: 'text/calendar',
              disposition: 'attachment'
            }];
            sgMail.send(mailMsg)
              .then(() => {
                res.json({ message: 'Teilnahme gespeichert. (Mail inkl. ICS versendet)' });
              })
              .catch(sendError => {
                res.status(500).json({ message: 'Fehler beim Senden der Mail', detail: sendError });
              });
          });
        } catch (err) {
          sgMail.send(mailMsg)
            .then(() => {
              res.json({ message: 'Teilnahme gespeichert. (Mail ohne ICS versendet, Fehler im Datum)', icsError: err });
            })
            .catch(sendError => {
              res.status(500).json({ message: 'Fehler beim Senden der Mail ohne ICS', detail: sendError });
            });
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

// --- KIOSK ENDPOINTS ---
// Kühlschränke mit Inhalt
app.get('/api/kiosk/kuehlschraenke', authenticateToken, async (req, res) => {
  try {
    const resK = await pool.query('SELECT * FROM kuehlschraenke');
    for (const k of resK.rows) {
      const inhalt = await pool.query(
        `SELECT ki.id, p.name, ki.bestand
         FROM kuehlschrank_inhalt ki
         JOIN produkte p ON ki.produkt_id = p.id
         WHERE ki.kuehlschrank_id = $1`,
        [k.id]
      );
      k.inhalt = inhalt.rows;
    }
    res.json(resK.rows);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Kühlschränke', error: err.message });
  }
});

// Kühlschrank anlegen
app.post('/api/kiosk/kuehlschraenke', authenticateToken, async (req, res) => {
  const { name, standort } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO kuehlschraenke (name, standort) VALUES ($1, $2) RETURNING *',
      [name, standort]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Anlegen', error: err.message });
  }
});

// Produkt zu Kühlschrank hinzufügen oder Bestand ändern
app.post('/api/kiosk/kuehlschraenke/:id/inhalt', authenticateToken, async (req, res) => {
  const kuehlschrank_id = req.params.id;
  const { name, bestand, produktId } = req.body;
  try {
    let prodId = produktId;
    if (!prodId) {
      const prodRes = await pool.query('SELECT id FROM produkte WHERE name = $1', [name]);
      if (prodRes.rows.length === 0) {
        const newProd = await pool.query('INSERT INTO produkte (name) VALUES ($1) RETURNING id', [name]);
        prodId = newProd.rows[0].id;
      } else {
        prodId = prodRes.rows[0].id;
      }
    }
    const inhaltRes = await pool.query(
      'SELECT id FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1 AND produkt_id = $2',
      [kuehlschrank_id, prodId]
    );
    if (inhaltRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO kuehlschrank_inhalt (kuehlschrank_id, produkt_id, bestand) VALUES ($1, $2, $3)',
        [kuehlschrank_id, prodId, bestand]
      );
    } else {
      await pool.query(
        'UPDATE kuehlschrank_inhalt SET bestand = $1 WHERE kuehlschrank_id = $2 AND produkt_id = $3',
        [bestand, kuehlschrank_id, prodId]
      );
    }
    res.json({ message: "Produkt gespeichert" });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Speichern des Produkts', error: err.message });
  }
});

// Produkt aus Kühlschrank entfernen
app.delete('/api/kiosk/kuehlschraenke/:id/inhalt/:produktId', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1 AND produkt_id = $2',
      [req.params.id, req.params.produktId]
    );
    res.json({ message: "Produkt entfernt" });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Entfernen des Produkts', error: err.message });
  }
});

// Verkauf (Kasse) – Bestand synchronisieren
app.post('/api/kiosk/verkauf', authenticateToken, async (req, res) => {
  const { produktId, anzahl, kuehlschrankId } = req.body;
  try {
    const inhaltRes = await pool.query(
      'SELECT bestand FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1 AND produkt_id = $2',
      [kuehlschrankId, produktId]
    );
    if (inhaltRes.rows.length === 0 || inhaltRes.rows[0].bestand < anzahl) {
      return res.status(400).json({ message: "Nicht genug Bestand!" });
    }
    await pool.query(
      'UPDATE kuehlschrank_inhalt SET bestand = bestand - $1 WHERE kuehlschrank_id = $2 AND produkt_id = $3',
      [anzahl, kuehlschrankId, produktId]
    );
    await pool.query(
      'INSERT INTO verkauf (produkt_id, anzahl, username) VALUES ($1, $2, $3)',
      [produktId, anzahl, req.user.username]
    );
    res.json({ message: "Verkauf gebucht!" });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Verkauf', error: err.message });
  }
});

// --- Serverstart ---
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});