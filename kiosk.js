const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// Nutze dieselbe Pool-Konfiguration wie in index.js!
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Auth-Middleware direkt hier definieren
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

// --- Alle Kühlschränke mit Inhalt ---
router.get('/kuehlschraenke', authenticateToken, async (req, res) => {
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

// --- Kühlschrank anlegen ---
router.post('/kuehlschraenke', authenticateToken, async (req, res) => {
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

// --- Produkt zu Kühlschrank hinzufügen oder Bestand ändern ---
router.post('/kuehlschraenke/:id/inhalt', authenticateToken, async (req, res) => {
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

// --- Produkt aus Kühlschrank entfernen ---
router.delete('/kuehlschraenke/:id/inhalt/:produktId', authenticateToken, async (req, res) => {
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

// --- Verkauf (Kasse) – Bestand synchronisieren ---
router.post('/verkauf', authenticateToken, async (req, res) => {
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

module.exports = router;