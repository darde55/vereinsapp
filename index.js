require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Setze SendGrid API Key
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
      'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4)',
      [username, email, hashedPassword, role]
    );
    res.status(201).json({ message: 'User registriert' });
  } catch (err) {
    console.error('Fehler bei Registrierung:', err);
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
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    console.error('Fehler beim Login:', err);
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
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler beim Laden des Profils:', err);
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
    console.error('Fehler beim Laden deiner Termine:', err);
    res.status(500).json({ message: 'Fehler beim Laden deiner Termine', error: err.message });
  }
});

// --- Benutzerverwaltung (Admin) ---
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT username, email, role, score FROM users');
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Laden der Benutzer:', err);
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
    console.error('Fehler beim Anlegen des Benutzers:', err);
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
    console.error('Fehler beim Bearbeiten des Benutzers:', err);
    res.status(500).json({ message: 'Fehler beim Bearbeiten des Benutzers', error: err.message });
  }
});

app.delete('/api/users/:username', authenticateToken, async (req, res) => {
  const username = req.params.username;
  try {
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ message: 'Benutzer gelöscht' });
  } catch (err) {
    console.error('Fehler beim Löschen des Benutzers:', err);
    res.status(500).json({ message: 'Fehler beim Löschen des Benutzers', error: err.message });
  }
});

// --- CRUD Termine ---
app.get('/api/termine', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM termine ORDER BY datum ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Laden der Termine:', err);
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
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Fehler beim Erstellen des Termins:', err);
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
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler beim Bearbeiten des Termins:', err);
    res.status(500).json({ message: 'Fehler beim Bearbeiten des Termins', error: err.message });
  }
});

app.delete('/api/termine/:id', authenticateToken, async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query('DELETE FROM termine WHERE id = $1', [id]);
    res.json({ message: 'Termin gelöscht' });
  } catch (err) {
    console.error('Fehler beim Löschen des Termins:', err);
    res.status(500).json({ message: 'Fehler beim Löschen des Termins', error: err.message });
  }
});

// --- Teilnahme an/abmelden (mit Bestätigungsmail & detailliertem Logging) ---
app.post('/api/termine/:id/teilnehmen', authenticateToken, async (req, res) => {
  const termin_id = req.params.id;
  const username = req.body.username || req.user.username;
  try {
    await pool.query(
      'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [termin_id, username]
    );

    // Hole E-Mail und Termin-Infos für Bestätigung
    const userRes = await pool.query('SELECT email FROM users WHERE username = $1', [username]);
    const terminRes = await pool.query('SELECT titel, datum, beginn, ende FROM termine WHERE id = $1', [termin_id]);

    if (userRes.rows.length && terminRes.rows.length) {
      const userEmail = userRes.rows[0].email;
      const termin = terminRes.rows[0];

      // Sende Bestätigungsmail mit detailliertem Fehler-Log
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
    console.error('Fehler bei Teilnahme:', err);
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
    res.json({ message: 'Teilnahme entfernt' });
  } catch (err) {
    console.error('Fehler beim Entfernen der Teilnahme:', err);
    res.status(500).json({ message: 'Fehler beim Entfernen der Teilnahme', error: err.message });
  }
});

// --- Alle Teilnehmer für einen Termin ---
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
    console.error('Fehler beim Laden der Teilnehmer:', err);
    res.status(500).json({ message: 'Fehler beim Laden der Teilnehmer', error: err.message });
  }
});

// --- Stichtags-Mail & automatische Zuweisung am Stichtag (täglich 7:00 Uhr) ---
cron.schedule('0 7 * * *', async () => {
  try {
    const heute = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
    const termineRes = await pool.query(
      `SELECT * FROM termine WHERE stichtag = $1 AND stichtag_mail_gesendet = false`, [heute]
    );
    for (const termin of termineRes.rows) {
      // 1. Teilnehmer für den Termin
      const teilnehmerRes = await pool.query(
        `SELECT users.username, users.email
         FROM teilnahmen
         JOIN users ON users.username = teilnahmen.username
         WHERE teilnahmen.termin_id = $1`,
        [termin.id]
      );
      const teilnehmer = teilnehmerRes.rows;
      const teilnehmerUsernames = teilnehmer.map(t => t.username);
      const anzahlMax = termin.anzahl || 0;
      const restplaetze = anzahlMax - teilnehmerUsernames.length;

      // 2. Zufallsauswahl für Restplätze (nur wenn Restplätze > 0)
      let neueTeilnehmer = [];
      if (restplaetze > 0) {
        // Alle User, die noch NICHT teilnehmen, nach Score sortiert, niedrigster zuerst
        const unteilgenommeneRes = await pool.query(
          `SELECT username, email, score
           FROM users
           WHERE username NOT IN (
             SELECT username FROM teilnahmen WHERE termin_id = $1
           )
           ORDER BY score ASC`,
          [termin.id]
        );

        if (unteilgenommeneRes.rows.length > 0) {
          // Nur User mit minimalem Score auswählen
          const minScore = unteilgenommeneRes.rows[0].score;
          const minScoreUsers = unteilgenommeneRes.rows.filter(u => u.score === minScore);

          // Mische Kandidaten zufällig
          const shuffled = minScoreUsers.sort(() => 0.5 - Math.random());
          neueTeilnehmer = shuffled.slice(0, restplaetze);

          // Trage ausgewählte User als Teilnehmer ein und schicke Mail
          for (const user of neueTeilnehmer) {
            await pool.query(
              'INSERT INTO teilnahmen (termin_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [termin.id, user.username]
            );
            // Sende Mail mit Fehler-Log
            sgMail.send({
              to: user.email,
              from: process.env.MAIL_FROM,
              subject: `Automatische Teilnahme am Termin "${termin.titel}"`,
              text: `Du wurdest automatisch für den Termin "${termin.titel}" am ${termin.datum} ausgewählt, weil noch Plätze frei waren.`
            }).then(() => {
              console.log(`Automatische Auswahl-Mail an ${user.username} erfolgreich versendet.`);
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
        }
      }

      // 3. Teilnehmerliste aktualisieren (inkl. automatisch zugewiesener)
      const neueTeilnehmerUsernames = neueTeilnehmer.map(u => u.username);
      const gesamtUsernames = [...teilnehmerUsernames, ...neueTeilnehmerUsernames];
      let neueTeilnehmerObjekte = neueTeilnehmer.map(u => ({username: u.username, email: u.email}));
      let alleTeilnehmer = [...teilnehmer, ...neueTeilnehmerObjekte];

      // 4. Mailtext für Ansprechpartner
      const teilnehmerListe = alleTeilnehmer.map(t => `${t.username} (${t.email})`).join('\n') || 'Noch keine Anmeldungen.';
      const mailText = `Der Stichtag für den Termin "${termin.titel}" ist erreicht.\n\nTeilnehmerliste:\n${teilnehmerListe}`;

      // 5. Mail an Ansprechpartner verschicken mit Fehler-Log
      sgMail.send({
        to: termin.ansprechpartner_mail,
        from: process.env.MAIL_FROM,
        subject: `Stichtag erreicht: "${termin.titel}"`,
        text: mailText
      }).then(() => {
        console.log(`Stichtagsmail an ${termin.ansprechpartner_mail} erfolgreich versendet.`);
      }).catch(error => {
        console.error('Stichtagsmail-Versand fehlgeschlagen!');
        if (error.response) {
          console.error('Status:', error.response.statusCode);
          console.error('Body:', error.response.body);
        }
        console.error('Fehlerobjekt:', error);
        console.log('SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'gesetzt' : 'NICHT gesetzt');
        console.log('MAIL_FROM:', process.env.MAIL_FROM);
      });

      // 6. Flag setzen, damit Mail nur 1x verschickt wird
      await pool.query(
        `UPDATE termine SET stichtag_mail_gesendet = true WHERE id = $1`,
        [termin.id]
      );
    }
    if (termineRes.rows.length > 0) {
      console.log(`Stichtagsmails und automatische Zuweisungen für ${termineRes.rows.length} Termine durchgeführt.`);
    }
  } catch (err) {
    console.error('Fehler beim Senden der Stichtagsmails/Zuweisungen:', err);
    if (err.stack) console.error(err.stack);
  }
});

// --- Server starten ---
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});