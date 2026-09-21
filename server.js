const express = require('express');
const path = require('path');
const app = express();

// Динамический порт: берем из настроек сервера (для деплоя) или 3000 для локальной разработки
const PORT = process.env.PORT || 3000;

// Разрешаем Express автоматически отдавать любые статические файлы (css, js, картинки) из папки "public"
app.use(express.static(path.join(__dirname, 'public')));

// Отдаем главный HTML-файл
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запускаем сервер
app.listen(PORT, () => {
  console.log(`Сервер запущен! Откройте http://localhost:${PORT} в браузере`);
});
