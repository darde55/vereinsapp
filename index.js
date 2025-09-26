require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Test-Route, damit du prüfen kannst ob das Backend läuft
app.get('/api/ping', (req, res) => {
  res.json({ message: 'pong' });
});

// Default-Route
app.get('/', (req, res) => {
  res.send('Vereinsverwaltung Backend läuft!');
});

app.listen(port, () => {
  console.log(`Server läuft auf Port ${port}`);
});