const express = require('express');

module.exports = function(pool, authenticateToken) {
  const router = express.Router();

  // --- KÜHLSCHRÄNKE ---
  router.get('/kuehlschraenke', authenticateToken, async (req, res) => {
    try {
      const resK = await pool.query('SELECT * FROM kuehlschraenke');
      for (const k of resK.rows) {
        const inhalt = await pool.query(
          `SELECT ki.id, p.id as produkt_id, p.name, ki.bestand, p.preis, p.kategorie
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

  router.delete('/kuehlschraenke/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1', [req.params.id]);
      await pool.query('DELETE FROM kuehlschränke WHERE id = $1', [req.params.id]);
      res.json({ message: "Kühlschrank gelöscht" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Löschen des Kühlschranks', error: err.message });
    }
  });

  router.get('/kuehlschraenke/:id', authenticateToken, async (req, res) => {
    try {
      const kRes = await pool.query('SELECT * FROM kuehlschraenke WHERE id = $1', [req.params.id]);
      if (kRes.rows.length === 0) {
        return res.status(404).json({ message: 'Kühlschrank nicht gefunden' });
      }
      const k = kRes.rows[0];
      const inhalt = await pool.query(
        `SELECT ki.id, p.id as produkt_id, p.name, ki.bestand, p.preis, p.kategorie
         FROM kuehlschrank_inhalt ki
         JOIN produkte p ON ki.produkt_id = p.id
         WHERE ki.kuehlschrank_id = $1`,
        [k.id]
      );
      k.inhalt = inhalt.rows;
      res.json(k);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden des Kühlschranks', error: err.message });
    }
  });

  router.post('/kuehlschraenke/:id/inhalt', authenticateToken, async (req, res) => {
    const kuehlschrank_id = req.params.id;
    const { bestand, produktId } = req.body;
    try {
      const inhaltRes = await pool.query(
        'SELECT id FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1 AND produkt_id = $2',
        [kuehlschrank_id, produktId]
      );
      if (inhaltRes.rows.length === 0) {
        await pool.query(
          'INSERT INTO kuehlschrank_inhalt (kuehlschrank_id, produkt_id, bestand) VALUES ($1, $2, $3)',
          [kuehlschrank_id, produktId, bestand]
        );
      } else {
        await pool.query(
          'UPDATE kuehlschrank_inhalt SET bestand = $1 WHERE kuehlschrank_id = $2 AND produkt_id = $3',
          [bestand, kuehlschrank_id, produktId]
        );
      }
      res.json({ message: "Produkt gespeichert" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Speichern des Produkts', error: err.message });
    }
  });

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

  // --- PREISLISTE ---
  router.get('/preisliste', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM produkte ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Preisliste', error: err.message });
    }
  });

  router.post('/preisliste', authenticateToken, async (req, res) => {
    const { name, preis, kategorie } = req.body;
    try {
      await pool.query(
        'INSERT INTO produkte (name, preis, kategorie) VALUES ($1, $2, $3)',
        [name, preis, kategorie]
      );
      res.status(201).json({ message: 'Produkt hinzugefügt' });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Hinzufügen', error: err.message });
    }
  });

  router.put('/preisliste/:id', authenticateToken, async (req, res) => {
    const { name, preis, kategorie } = req.body;
    try {
      await pool.query(
        'UPDATE produkte SET name=$1, preis=$2, kategorie=$3 WHERE id=$4',
        [name, preis, kategorie, req.params.id]
      );
      res.json({ message: 'Produkt aktualisiert' });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Aktualisieren', error: err.message });
    }
  });

  router.delete('/preisliste/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM produkte WHERE id = $1', [req.params.id]);
      res.json({ message: 'Produkt gelöscht' });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Löschen', error: err.message });
    }
  });

  // --- VERKAUFSSESSION ---
  // Session-Tabelle: verkaufssession (id, start, ende, benutzer)
  router.post('/session/start', authenticateToken, async (req, res) => {
    const benutzer = req.user.username;
    try {
      const result = await pool.query(
        'INSERT INTO verkaufssession (start, benutzer) VALUES (NOW(), $1) RETURNING *',
        [benutzer]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Starten der Session', error: err.message });
    }
  });

  router.post('/session/end/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('UPDATE verkaufssession SET ende = NOW() WHERE id = $1', [req.params.id]);
      res.json({ message: "Session beendet" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Beenden der Session', error: err.message });
    }
  });

  // --- KASSE / VERKAUF ---
  router.post('/verkauf', authenticateToken, async (req, res) => {
    const { produktId, anzahl, sessionId } = req.body;
    const username = req.user && req.user.username;
    try {
      const inhaltRes = await pool.query(
        'SELECT id, kuehlschrank_id, bestand FROM kuehlschrank_inhalt WHERE produkt_id = $1 ORDER BY bestand DESC',
        [produktId]
      );
      const gesamtBestand = inhaltRes.rows.reduce((sum, row) => sum + row.bestand, 0);
      if (gesamtBestand < anzahl) {
        return res.status(400).json({ message: "Nicht genug Gesamtbestand!" });
      }
      let rest = anzahl;
      for (const row of inhaltRes.rows) {
        if (rest <= 0) break;
        const abzuziehen = Math.min(row.bestand, rest);
        if (abzuziehen > 0) {
          await pool.query(
            'UPDATE kuehlschrank_inhalt SET bestand = bestand - $1 WHERE id = $2',
            [abzuziehen, row.id]
          );
          await pool.query(
            'INSERT INTO verkauf (produkt_id, anzahl, username, verkauft_am, kuehlschrank_id, session_id) VALUES ($1, $2, $3, NOW(), $4, $5)',
            [produktId, abzuziehen, username, row.kuehlschrank_id, sessionId]
          );
          rest -= abzuziehen;
        }
      }
      res.json({ message: "Verkauf gebucht!" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Verkauf', error: err.message });
    }
  });

  // --- STATISTIK ---
  // Umsatz pro Monat/Jahr
  router.get('/statistik/gesamteinahmen', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT DATE_TRUNC('month', verkauft_am) AS monat,
                SUM(p.preis * v.anzahl) AS umsatz
           FROM verkauf v
           JOIN produkte p ON v.produkt_id = p.id
           GROUP BY monat
           ORDER BY monat`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Einnahmen', error: err.message });
    }
  });

  // Bestseller-Produkte pro Monat/Jahr
  router.get('/statistik/bestseller', authenticateToken, async (req, res) => {
    const { jahr, monat } = req.query;
    let where = '';
    let params = [];
    if (jahr) {
      where += ` AND EXTRACT(YEAR FROM verkauft_am) = $${params.length+1}`;
      params.push(jahr);
    }
    if (monat) {
      where += ` AND EXTRACT(MONTH FROM verkauft_am) = $${params.length+1}`;
      params.push(monat);
    }
    try {
      const result = await pool.query(
        `SELECT p.name, SUM(v.anzahl) AS verkauft
           FROM verkauf v
           JOIN produkte p ON v.produkt_id = p.id
           WHERE 1=1 ${where}
           GROUP BY p.name
           ORDER BY verkauft DESC
           LIMIT 10`,
        params
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Bestseller', error: err.message });
    }
  });

  // Detail-Tabelle: Alle Verkäufe (optional, für Tabelle)
  router.get('/statistik/verkaeufe', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT v.id, v.verkauft_am, p.name, v.anzahl, v.kuehlschrank_id, v.username
           FROM verkauf v
           JOIN produkte p ON v.produkt_id = p.id
           ORDER BY v.verkauft_am DESC
           LIMIT 100`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Verkäufe', error: err.message });
    }
  });

  // Verkaufssessions mit Umsatz und verkaufte Produkte
  router.get('/statistik/sessions', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT s.id, s.start, s.ende, s.benutzer,
          COALESCE(SUM(p.preis * v.anzahl), 0) AS umsatz,
          COALESCE(SUM(v.anzahl), 0) AS produkte
         FROM verkaufssession s
         LEFT JOIN verkauf v ON v.session_id = s.id
         LEFT JOIN produkte p ON v.produkt_id = p.id
         GROUP BY s.id
         ORDER BY s.start DESC`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Sessions', error: err.message });
    }
  });

  return router;
};