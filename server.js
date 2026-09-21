const express = require('express');
const path = require('path');

const app = express();

// Указываем порт, который требует Render, или 3000 для локального теста
const PORT = process.env.PORT || 3000;

// Безопасно подключаем текущую папку (корень проекта, где лежит index.html)
app.use(express.static(__dirname));

// Обработка главной страницы
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Универсальный обработчик для подстраховки (чтобы не было Not Found)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
