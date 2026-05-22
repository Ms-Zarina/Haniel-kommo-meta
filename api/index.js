// Vercel serverless entrypoint.
// Vercel ищет файлы в /api и оборачивает их экспорт в serverless function.
// Здесь мы просто реэкспортируем готовый Express app из ../server.js.
// Сама бизнес-логика, роуты и middleware — в server.js (не дублируем).
module.exports = require("../server.js");
