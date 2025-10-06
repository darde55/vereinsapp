const express = require('express');

module.exports = function(pool, authenticateToken) {
  const router = express.Router();

  // --- KÜHLSCHRÄNKE ---
  router.get('/kuehlschraenke', authenticateToken, async (req, res) => {
    try {
      const resK = await pool.query('SELECT * FROM kuehlschraenke');
      for (const k of resK.rows) {
        const inhalt = await pool.query(
          `SELECT ki.id, p.id as produkt_id, p.name, ki.bestand, p.preis
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
      await pool.query('DELETE FROM kuehlschraenke WHERE id = $1', [req.params.id]);
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
        `SELECT ki.id, p.id as produkt_id, p.name, ki.bestand, p.preis
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

  // Produkt im Kühlschrank hinzufügen oder bearbeiten
  router.post('/kuehlschraenke/:id/inhalt', authenticateToken, async (req, res) => {
    const kuehlschrank_id = req.params.id;
    const { bestand, produktId } = req.body;
    try {
      // Prüfe, ob das Produkt schon im Kühlschrank ist
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

  // Produkt aus Kühlschrank entfernen
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

  // --- KASSE / VERKAUF ---
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
        'INSERT INTO verkauf (produkt_id, anzahl, username, verkauft_am) VALUES ($1, $2, $3, NOW())',
        [produktId, anzahl, req.user.username]
      );
      res.json({ message: "Verkauf gebucht!" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Verkauf', error: err.message });
    }
  });

  // --- STATISTIK ---
  router.get('/statistik/gesamteinahmen', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT DATE_TRUNC('year', verkauft_am) AS jahr,
                DATE_TRUNC('month', verkauft_am) AS monat,
                SUM(p.preis * v.anzahl) AS umsatz
           FROM verkauf v
           JOIN produkte p ON v.produkt_id = p.id
           GROUP BY jahr, monat
           ORDER BY jahr, monat`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Einnahmen', error: err.message });
    }
  });

  router.get('/statistik/produktJahr', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT p.name, EXTRACT(YEAR FROM verkauft_am) AS jahr, SUM(v.anzahl) AS verkauft
           FROM verkauf v
           JOIN produkte p ON v.produkt_id = p.id
           GROUP BY p.name, jahr
           ORDER BY jahr, p.name`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Statistik', error: err.message });
    }
  });

  return router;
};