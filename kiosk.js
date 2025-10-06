const express = require('express');

module.exports = function(pool, authenticateToken) {
  const router = express.Router();

  // --- KÜHLSCHRÄNKE ---
  router.get('/kuehlschraenke', authenticateToken, async (req, res) => {
    console.log("[GET] /kuehlschraenke");
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
      console.error("[GET] /kuehlschraenke Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Laden der Kühlschränke', error: err.message });
    }
  });

  router.post('/kuehlschraenke', authenticateToken, async (req, res) => {
    console.log("[POST] /kuehlschraenke", req.body);
    const { name, standort } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO kuehlschraenke (name, standort) VALUES ($1, $2) RETURNING *',
        [name, standort]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("[POST] /kuehlschraenke Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Anlegen', error: err.message });
    }
  });

  router.delete('/kuehlschraenke/:id', authenticateToken, async (req, res) => {
    console.log("[DELETE] /kuehlschraenke/:id", req.params.id);
    try {
      await pool.query('DELETE FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1', [req.params.id]);
      await pool.query('DELETE FROM kuehlschraenke WHERE id = $1', [req.params.id]);
      res.json({ message: "Kühlschrank gelöscht" });
    } catch (err) {
      console.error("[DELETE] /kuehlschraenke/:id Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Löschen des Kühlschranks', error: err.message });
    }
  });

  router.get('/kuehlschraenke/:id', authenticateToken, async (req, res) => {
    console.log("[GET] /kuehlschraenke/:id", req.params.id);
    try {
      const kRes = await pool.query('SELECT * FROM kuehlschraenke WHERE id = $1', [req.params.id]);
      if (kRes.rows.length === 0) {
        console.warn("[GET] /kuehlschraenke/:id - Kühlschrank nicht gefunden", req.params.id);
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
      console.error("[GET] /kuehlschraenke/:id Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Laden des Kühlschranks', error: err.message });
    }
  });

  // Produkt im Kühlschrank hinzufügen oder bearbeiten
  router.post('/kuehlschraenke/:id/inhalt', authenticateToken, async (req, res) => {
    console.log("[POST] /kuehlschraenke/:id/inhalt", req.params.id, req.body);
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
        console.log("[POST] Neuer Kühlschrank-Inhalt angelegt:", { kuehlschrank_id, produktId, bestand });
      } else {
        await pool.query(
          'UPDATE kuehlschrank_inhalt SET bestand = $1 WHERE kuehlschrank_id = $2 AND produkt_id = $3',
          [bestand, kuehlschrank_id, produktId]
        );
        console.log("[POST] Kühlschrank-Inhalt aktualisiert:", { kuehlschrank_id, produktId, bestand });
      }
      res.json({ message: "Produkt gespeichert" });
    } catch (err) {
      console.error("[POST] /kuehlschraenke/:id/inhalt Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Speichern des Produkts', error: err.message });
    }
  });

  router.delete('/kuehlschraenke/:id/inhalt/:produktId', authenticateToken, async (req, res) => {
    console.log("[DELETE] /kuehlschraenke/:id/inhalt/:produktId", req.params.id, req.params.produktId);
    try {
      await pool.query(
        'DELETE FROM kuehlschrank_inhalt WHERE kuehlschrank_id = $1 AND produkt_id = $2',
        [req.params.id, req.params.produktId]
      );
      res.json({ message: "Produkt entfernt" });
    } catch (err) {
      console.error("[DELETE] /kuehlschraenke/:id/inhalt/:produktId Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Entfernen des Produkts', error: err.message });
    }
  });

  // --- PREISLISTE ---
  router.get('/preisliste', authenticateToken, async (req, res) => {
    console.log("[GET] /preisliste");
    try {
      const result = await pool.query('SELECT * FROM produkte ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      console.error("[GET] /preisliste Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Laden der Preisliste', error: err.message });
    }
  });

  router.post('/preisliste', authenticateToken, async (req, res) => {
    console.log("[POST] /preisliste", req.body);
    const { name, preis, kategorie } = req.body;
    try {
      await pool.query(
        'INSERT INTO produkte (name, preis, kategorie) VALUES ($1, $2, $3)',
        [name, preis, kategorie]
      );
      res.status(201).json({ message: 'Produkt hinzugefügt' });
    } catch (err) {
      console.error("[POST] /preisliste Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Hinzufügen', error: err.message });
    }
  });

  router.put('/preisliste/:id', authenticateToken, async (req, res) => {
    console.log("[PUT] /preisliste/:id", req.params.id, req.body);
    const { name, preis, kategorie } = req.body;
    try {
      await pool.query(
        'UPDATE produkte SET name=$1, preis=$2, kategorie=$3 WHERE id=$4',
        [name, preis, kategorie, req.params.id]
      );
      res.json({ message: 'Produkt aktualisiert' });
    } catch (err) {
      console.error("[PUT] /preisliste/:id Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Aktualisieren', error: err.message });
    }
  });

  router.delete('/preisliste/:id', authenticateToken, async (req, res) => {
    console.log("[DELETE] /preisliste/:id", req.params.id);
    try {
      await pool.query('DELETE FROM produkte WHERE id = $1', [req.params.id]);
      res.json({ message: 'Produkt gelöscht' });
    } catch (err) {
      console.error("[DELETE] /preisliste/:id Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Löschen', error: err.message });
    }
  });

  // --- KASSE / VERKAUF ---
  // Diese Route prüft den Gesamtbestand aller Kühlschränke und verteilt den Verkauf!
  router.post('/verkauf', authenticateToken, async (req, res) => {
    const { produktId, anzahl } = req.body;
    const username = req.user && req.user.username;
    console.log("[POST] /verkauf Request:", { produktId, anzahl, username });

    try {
      // Alle Kühlschränke mit diesem Produkt, sortiert nach Bestand absteigend
      const inhaltRes = await pool.query(
        'SELECT id, kuehlschrank_id, bestand FROM kuehlschrank_inhalt WHERE produkt_id = $1 ORDER BY bestand DESC',
        [produktId]
      );
      console.log("[POST] /verkauf Gesamt-Kühlschrank-Inhalt:", inhaltRes.rows);

      const gesamtBestand = inhaltRes.rows.reduce((sum, row) => sum + row.bestand, 0);
      if (gesamtBestand < anzahl) {
        console.warn(`[POST] /verkauf Gesamt-Bestand zu niedrig! Ist=${gesamtBestand}, Soll=${anzahl}`);
        return res.status(400).json({ message: "Nicht genug Gesamtbestand!" });
      }

      // Verkauf verteilen auf Kühlschränke
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
            'INSERT INTO verkauf (produkt_id, anzahl, username, verkauft_am, kuehlschrank_id) VALUES ($1, $2, $3, NOW(), $4)',
            [produktId, abzuziehen, username, row.kuehlschrank_id]
          );
          console.log(`[POST] /verkauf Abgezogen: ${abzuziehen} von Kühlschrank ${row.kuehlschrank_id}`);
          rest -= abzuziehen;
        }
      }

      console.log(`[POST] /verkauf Verkauf erfolgreich: ProduktId=${produktId}, Anzahl=${anzahl}, User=${username}`);
      res.json({ message: "Verkauf gebucht!" });
    } catch (err) {
      console.error("[POST] /verkauf Fehler beim Verkauf:", err);
      res.status(500).json({ message: 'Fehler beim Verkauf', error: err.message });
    }
  });

  // --- STATISTIK ---
  router.get('/statistik/gesamteinahmen', authenticateToken, async (req, res) => {
    console.log("[GET] /statistik/gesamteinahmen");
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
      console.error("[GET] /statistik/gesamteinahmen Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Laden der Einnahmen', error: err.message });
    }
  });

  router.get('/statistik/produktJahr', authenticateToken, async (req, res) => {
    console.log("[GET] /statistik/produktJahr");
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
      console.error("[GET] /statistik/produktJahr Fehler:", err);
      res.status(500).json({ message: 'Fehler beim Laden der Statistik', error: err.message });
    }
  });

  return router;
};