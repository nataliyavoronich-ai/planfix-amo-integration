// ============================================================
//  ГЛАВНЫЙ ФАЙЛ СЕРВЕРА
// ============================================================

require('dotenv').config();
const express = require('express');
const planfix = require('./planfix');
const amo = require('./amomessenger');

const app = express();
app.use(express.json());

const SECRET = process.env.WEBHOOK_SECRET;

// Простой кеш для предотвращения дублирования исходящих сообщений
// (храним ID комментариев, которые уже были обработаны)
const processedComments = new Set();

function checkSecret(req, res, next) {
  if (req.query.secret !== SECRET) {
    return res.status(403).send('forbidden');
  }
  next();
}

// -----------------------------------------------------------
// OAuth callback
// -----------------------------------------------------------
app.get('/oauth', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Не пришёл параметр code');
  }
  console.log('Получен код авторизации:', code.slice(0, 10) + '...');
  try {
    const tokenData = await amo.exchangeCodeForToken(code);
    console.log('✅ Получен access_token:', tokenData.access_token);
    const context = await amo.validateToken(tokenData.access_token);
    console.log('Контекст:', context);
    res.send(`
      <h2>Приложение успешно подключено!</h2>
      <p>Токен: <code>${tokenData.access_token}</code></p>
      <p>Скопируйте его в переменную AMO_ACCESS_TOKEN на Render и перезапустите.</p>
    `);
  } catch (err) {
    console.error('❌ Ошибка OAuth:', err);
    res.status(500).send('Ошибка получения токена, смотрите логи.');
  }
});

// -----------------------------------------------------------
// Вебхук от amoMessenger (входящие сообщения)
// -----------------------------------------------------------
app.post('/webhook/amomessenger', checkSecret, async (req, res) => {
  console.log('📩 Полный body от amoMessenger:', JSON.stringify(req.body, null, 2));

  try {
    const { userId, userName, text, attachments, raw } = amo.parseIncomingMessage(req.body);

    let messageText = text;
    if (!messageText && attachments && attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      messageText = `Файлы: ${names}`;
    }

    console.log('Входящее сообщение от', userId, ':', messageText);
    if (attachments && attachments.length > 0) {
      console.log('📎 Вложений:', attachments.length);
      attachments.forEach(a => console.log('  -', a.name, '=>', a.url));
    }

    if (!userId || (!messageText && (!attachments || attachments.length === 0))) {
      console.log('Пустое сообщение без содержимого, игнорируем');
      return res.sendStatus(200);
    }

    let realUserName = userName;
    if (!realUserName || realUserName.startsWith('Пользователь ') || realUserName === userId) {
      console.log(`👤 Имя пользователя не получено из вебхука, запрашиваем через API...`);
      const nameFromApi = await amo.getUserInfo(userId);
      if (nameFromApi) {
        realUserName = nameFromApi;
        console.log(`✅ Имя получено из API: ${realUserName}`);
      } else {
        realUserName = userId;
        console.log(`⚠️ Не удалось получить имя, используем ID: ${realUserName}`);
      }
    }

    // Находим или создаём контакт по внешнему коду (amoUserId)
    const contactId = await planfix.findOrCreateContactId(userId, realUserName);
    console.log(`✅ Контакт ID: ${contactId}`);

    const openTask = await planfix.findOpenTaskByContactId(contactId);

    if (openTask) {
      await planfix.addComment(openTask.id, messageText);
      console.log('➕ Комментарий добавлен в задачу #' + openTask.id);
    } else {
      const newTask = await planfix.createTask({
        contactId,
        amoUserId: userId,
        amoUserName: realUserName,
        text: messageText,
        attachments,
      });
      console.log('🆕 Создана новая задача:', JSON.stringify(newTask));
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки сообщения из amoMessenger:', err.message);
    res.sendStatus(500);
  }
});

// -----------------------------------------------------------
// Вебхук от Planfix (ответы из задач → в amoMessenger)
// -----------------------------------------------------------
app.post('/webhook/planfix', checkSecret, async (req, res) => {
  console.log('📩 Полный запрос от Планфикса:');
  console.log('  Headers:', req.headers);
  console.log('  Body:', JSON.stringify(req.body, null, 2));

  try {
    // Генерируем уникальный ключ для этого комментария
    const taskId = req.headers['x-planfix-task'];
    const commentId = req.body.commentId || req.body.id || req.body.comment_id;
    const uniqueKey = `${taskId}_${commentId || Date.now()}`;

    // Проверяем, не обрабатывали ли уже этот комментарий
    if (processedComments.has(uniqueKey)) {
      console.log(`⚠️ Дублирующий вебхук для ${uniqueKey}, игнорируем`);
      return res.sendStatus(200);
    }

    // 1. Берём amoUserId из тела запроса
    let amoUserId = req.body.amoUserId || null;
    let commentText = req.body.commentText || req.body.comment || req.body.text || req.body.message || req.body.description;

    if (!amoUserId) {
      console.warn('⚠️ amoUserId не найден в теле запроса. Доступные поля:', Object.keys(req.body));
      return res.sendStatus(200);
    }

    if (!commentText) {
      console.warn('⚠️ Не удалось извлечь текст комментария. Доступные поля:', Object.keys(req.body));
      return res.sendStatus(200);
    }

    // Очищаем HTML-теги
    const cleanText = commentText.replace(/<[^>]*>/g, '').trim();
    if (!cleanText) {
      console.warn('⚠️ После очистки HTML текст пуст');
      return res.sendStatus(200);
    }

    // Отмечаем комментарий как обработанный
    processedComments.add(uniqueKey);

    console.log(`📤 Отправляем сообщение пользователю ${amoUserId}: ${cleanText}`);
    await amo.sendMessage(amoUserId, cleanText);
    console.log('✅ Сообщение успешно отправлено в amoMessenger');

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Планфикс:', err.message);
    res.sendStatus(200);
  }
});

// Проверка работоспособности
app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
});
