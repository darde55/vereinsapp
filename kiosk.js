const express = require('express');

module.exports = function(pool, authenticateToken) {
  const router = express.Router();

  // --- KÜHLSCHRÄNKE ---
  // Alle Kühlschränke abfragen
  router.get('/kuehlschraenke', authenticateToken, async (req, res) => {
    try {
      const resK = await pool.query('SELECT * FROM kuehlschraenke');
      for (const k of resK.rows) {
        const inhalt = await pool.query(
          `SELECT ki.id, p.name, ki.bestand, p.preis
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

  // Kühlschrank löschen (inklusive aller Inhalte)
  router.delete('/kuehlschraenke/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1', [req.params.id]);
      await pool.query('DELETE FROM kuehlschraenke WHERE id = $1', [req.params.id]);
      res.json({ message: "Kühlschrank gelöscht" });
    } catch (err) {
      res.status(500).json({ message: 'Fehler beim Löschen des Kühlschranks', error: err.message });
    }
  });

  return router;
};