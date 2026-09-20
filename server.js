const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

const BOT_TOKEN = process.env.BOT_TOKEN || '8952416846:AAHq94RzNvFb7uZVacvrr1Y8j0UD7Q3gLCU';
const BALANCES_FILE = path.join(__dirname, 'balances.json');

let userBalances = {};
try {
  if (fs.existsSync(BALANCES_FILE)) {
    userBalances = JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8'));
  }
} catch (e) {
  userBalances = {};
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/get-balance/:userId', (req, res) => {
  const { userId } = req.params;
  res.json({ success: true, balance: userBalances[userId] || 0 });
});

app.post('/api/create-stars-invoice', async (req, res) => {
  const { userId, amount, title } = req.body;
  try {
    const payloadData = JSON.stringify({ userId: userId.toString(), amount: Number(amount) });
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title || 'Top-up',
        description: `Purchase ${amount} Stars`,
        payload: payloadData,
        currency: 'XTR',
        prices: [{ label: `${amount} Stars`, amount: Number(amount) }]
      })
    });
    const data = await response.json();
    if (data.ok) {
      res.json({ success: true, invoiceLink: data.result });
    } else {
      res.status(400).json({ success: false, error: data.description });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server started on port ' + PORT);
});
```eof


