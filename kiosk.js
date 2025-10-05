const express = require('express');

module.exports = function(pool, authenticateToken) {
  const router = express.Router();

  // --- PREISLISTE ---
  // Alle Produkte mit Preis und Kategorie abfragen
  router.get('/preisliste', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT id, name, preis, kategorie FROM produkte ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Laden der Preisliste', error: err.message });
    }
  });

  // Produkt mit Preis und Kategorie hinzufügen
  router.post('/preisliste', authenticateToken, async (req, res) => {
    const { name, preis, kategorie } = req.body;
    if (!name || typeof preis !== 'number' || !kategorie) {
      return res.status(400).json({ message: 'Name, Preis und Kategorie sind erforderlich!' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO produkte (name, preis, kategorie) VALUES ($1, $2, $3) RETURNING *',
        [name, preis, kategorie]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Hinzufügen des Produkts', error: err.message });
    }
  });

  // --- KÜHLSCHRÄNKE ---
  router.get('/kuehlschraenke', authenticateToken, async (req, res) => {
    try {
      const resK = await pool.query('SELECT * FROM kuehlschraenke');
      for (const k of resK.rows) {
        const inhalt = await pool.query(
          `SELECT ki.id, p.name, ki.bestand, p.preis, p.kategorie
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

  // Produkt zu Kühlschrank hinzufügen oder Bestand ändern
  router.post('/kuehlschraenke/:id/inhalt', authenticateToken, async (req, res) => {
    const kuehlschrank_id = req.params.id;
    const { name, bestand, produktId, preis, kategorie } = req.body;
    try {
      let prodId = produktId;
      if (!prodId) {
        // Produkt aus Preisliste suchen oder anlegen
        const prodRes = await pool.query('SELECT id FROM produkte WHERE name = $1', [name]);
        if (prodRes.rows.length === 0) {
          // Falls Preis und Kategorie übergeben wird, direkt mit anlegen
          const newProd = await pool.query(
            'INSERT INTO produkte (name, preis, kategorie) VALUES ($1, $2, $3) RETURNING id',
            [name, preis ?? 0, kategorie ?? 'Alkoholfrei']
          );
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

  // Gesamten Kühlschrank löschen
  router.delete('/kuehlschraenke/:id', authenticateToken, async (req, res) => {
    try {
      // Entferne zuerst alle Inhalte, dann den Kühlschrank selbst
      await pool.query(
        'DELETE FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1',
        [req.params.id]
      );
      await pool.query(
        'DELETE FROM kuehlschraenke WHERE id = $1',
        [req.params.id]
      );
      res.json({ message: "Kühlschrank gelöscht" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Löschen des Kühlschranks', error: err.message });
    }
  });

  // Verkauf (Kasse) – Bestand synchronisieren und Verkauf speichern
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

  // --- AUSWERTUNG: Verkaufsstatistik für Zeitraum ---
  router.get('/auswertung', authenticateToken, async (req, res) => {
    const { from, to } = req.query;
    try {
      const result = await pool.query(
        `SELECT p.name AS produkt, p.kategorie, SUM(v.anzahl) AS verkauft, SUM(v.anzahl * p.preis) AS umsatz
         FROM verkauf v
         JOIN produkte p ON v.produkt_id = p.id
         WHERE v.verkauft_am BETWEEN $1 AND $2
         GROUP BY p.name, p.kategorie
         ORDER BY p.kategorie, p.name`,
        [from, to]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: 'Fehler bei der Auswertung', error: err.message });
    }
  });

  return router;
};