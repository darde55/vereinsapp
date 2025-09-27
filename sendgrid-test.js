const sgMail = require('@sendgrid/mail');

// Direkt den Key eintragen (anstatt aus .env)
const SENDGRID_API_KEY = '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';

console.log('API KEY:', SENDGRID_API_KEY);
console.log('Länge:', SENDGRID_API_KEY.length);

// Setze den API-Key
sgMail.setApiKey(SENDGRID_API_KEY);

// Test-E-Mail konfigurieren
const msg = {
  to: 'nick.bayer@gmx.de',            // <-- Hier deine empfangende E-Mail eintragen!
  from: 'tsvdienste@web.de',                   // Muss mit deinem verifizierten Absender übereinstimmen
  subject: 'SendGrid Testmail',
  text: 'Das ist eine Test-E-Mail über SendGrid!',
};

sgMail
  .send(msg)
  .then(() => {
    console.log('Testmail erfolgreich versendet!');
  })
  .catch((error) => {
    if (error.response && error.response.body) {
      console.error('Fehler beim Senden der Testmail:', error.response.body);
    } else {
      console.error('Fehler beim Senden der Testmail:', error.message);
    }
  });