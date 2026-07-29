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
  if (!code) return res.status(400).send('Не пришёл параметр code');
  try {
    const tokenData = await amo.exchangeCodeForToken(code);
    console.log('✅ Получен access_token:', tokenData.access_token);
    const context = await amo.validateToken(tokenData.access_token);
    console.log('Контекст:', context);
    res.send(`<h2>Приложение подключено!</h2><p>Токен: <code>${tokenData.access_token}</code></p>`);
  } catch (err) {
    console.error('❌ Ошибка OAuth:', err);
    res.status(500).send('Ошибка получения токена, смотрите логи.');
  }
});

// -----------------------------------------------------------
// Вебхук от amoMessenger (входящие)
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
      attachments.forEach(a => console.log('  -', a.name, '=>', a.url));
    }

    if (!userId || (!messageText && (!attachments || attachments.length === 0))) {
      console.log('Пустое сообщение, игнорируем');
      return res.sendStatus(200);
    }

    // Получаем реальное имя
    let realUserName = userName;
    if (!realUserName || realUserName.startsWith('Пользователь ') || realUserName === userId) {
      const nameFromApi = await amo.getUserInfo(userId);
      realUserName = nameFromApi || userId;
      console.log(`👤 Имя пользователя: ${realUserName}`);
    }

    // Находим или создаём контакт по имени
    const contactId = await planfix.findOrCreateContactId(realUserName);
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
// Вебхук от Planfix (исходящие)
// -----------------------------------------------------------
// Хранилище для ID уже обработанных сообщений (для защиты от дублей)
const processedMessages = new Set();

app.post('/webhook/planfix', checkSecret, async (req, res) => {
  console.log('📩 Полный запрос от Планфикса:');
  console.log('  Headers:', req.headers);
  console.log('  Body:', JSON.stringify(req.body, null, 2));

  try {
    // Проверка на дублирование: используем заголовок x-request-start или комбинацию taskId + commentText
    const taskId = req.headers['x-planfix-task'];
    const commentTextRaw = req.body.commentText || req.body.comment || req.body.text || req.body.message || req.body.description;
    if (!commentTextRaw) {
      console.warn('⚠️ Нет текста комментария');
      return res.sendStatus(200);
    }

    const messageKey = `${taskId}_${commentTextRaw.substring(0, 50)}`;
    if (processedMessages.has(messageKey)) {
      console.log(`⚠️ Дублирующее сообщение для задачи ${taskId}, пропускаем`);
      return res.sendStatus(200);
    }
    processedMessages.add(messageKey);
    // Очищаем хранилище, чтобы не росло бесконечно (оставляем только последние 1000)
    if (processedMessages.size > 1000) {
      const arr = Array.from(processedMessages);
      processedMessages.clear();
      arr.slice(-500).forEach(k => processedMessages.add(k));
    }

    // Извлекаем amoUserId
    let amoUserId = req.body.amoUserId || null;
    if (!amoUserId) {
      // Если в теле нет, пытаемся достать из задачи (но мы убрали эту функцию, так что просто игнорируем)
      console.warn('⚠️ amoUserId не найден в теле. Доступные поля:', Object.keys(req.body));
      return res.sendStatus(200);
    }

    // Очищаем HTML
    const cleanText = commentTextRaw.replace(/<[^>]*>/g, '').trim();
    if (!cleanText) {
      console.warn('⚠️ После очистки HTML текст пуст');
      return res.sendStatus(200);
    }

    console.log(`📤 Отправляем сообщение пользователю ${amoUserId}: ${cleanText}`);
    await amo.sendMessage(amoUserId, cleanText);
    console.log('✅ Сообщение успешно отправлено в amoMessenger');

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Планфикс:', err.message);
    res.sendStatus(200);
  }
});

// -----------------------------------------------------------
// Проверка
// -----------------------------------------------------------
app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
});
