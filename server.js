// ============================================================
//  ГЛАВНЫЙ ФАЙЛ СЕРВЕРА
// ============================================================

require('dotenv').config();
const express = require('express');
const planfix = require('./planfix');
const amo = require('./amomessenger');

const app = express();

// --- ПАРСИНГ ТЕЛА ЗАПРОСА ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET = process.env.WEBHOOK_SECRET;

function checkSecret(req, res, next) {
  if (req.query.secret !== SECRET) {
    return res.status(403).send('forbidden');
  }
  next();
}

// -----------------------------------------------------------
// Декодирование HTML-сущностей
// -----------------------------------------------------------
function decodeHtmlEntities(text) {
  if (!text) return '';
  const entities = {
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&laquo;': '«',
    '&raquo;': '»',
    '&mdash;': '—',
    '&ndash;': '–',
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  result = result.replace(/<[^>]*>/g, '');
  return result.trim();
}

// Хранилище для предотвращения дублирования
const processedMessages = new Set();

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
      console.log('📎 Вложений:', attachments.length);
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
// Вебхук от Planfix (исходящие сообщения и уведомления)
// -----------------------------------------------------------
app.post('/webhook/planfix', checkSecret, async (req, res) => {
  console.log('📩 Полный запрос от Планфикса:');
  console.log('  Headers:', req.headers);
  console.log('  Body:', req.body);

  try {
    const taskId = req.headers['x-planfix-task'];
    let amoUserId = null;
    let commentText = '';
    let attachments = [];

    // --- ОПРЕДЕЛЯЕМ amoUserId ---
    // Если есть поле amoUserId – берём его
    if (req.body.amoUserId) {
      amoUserId = req.body.amoUserId;
    }
    // Если есть chatId (приходит в form-urlencoded) – используем его
    else if (req.body.chatId) {
      amoUserId = req.body.chatId;
    }

    // Если всё ещё нет – пробуем получить из задачи по taskId
    if (!amoUserId && taskId) {
      console.log(`🔍 Получаем amoUserId для задачи ${taskId} через API...`);
      amoUserId = await planfix.getAmoUserIdFromTask(taskId);
    }

    if (!amoUserId) {
      console.warn('⚠️ amoUserId не найден, пропускаем');
      return res.sendStatus(200);
    }

    // --- ИЗВЛЕКАЕМ ТЕКСТ ---
    // Из полей commentText, comment, text, message, description
    commentText = req.body.commentText || req.body.comment || req.body.text || req.body.message || req.body.description || '';

    // --- ИЗВЛЕКАЕМ ВЛОЖЕНИЯ ---
    // 1. Если attachments пришли как массив
    if (req.body.attachments && Array.isArray(req.body.attachments)) {
      attachments = req.body.attachments;
    }
    // 2. Если attachments пришли как объект (например, { url: '...', name: '...' })
    else if (req.body.attachments && typeof req.body.attachments === 'object') {
      // Если это объект с полями url и name – добавляем как одно вложение
      if (req.body.attachments.url && req.body.attachments.name) {
        attachments.push({ name: req.body.attachments.name, url: req.body.attachments.url });
      } else {
        // Иначе это объект с индексами (если много вложений)
        const keys = Object.keys(req.body.attachments).filter(k => !isNaN(k));
        attachments = keys.map(k => req.body.attachments[k]);
      }
    }

    // Если нет ни текста, ни вложений – пропускаем
    if (!commentText && (!attachments || attachments.length === 0)) {
      console.warn('⚠️ Нет текста комментария и вложений, пропускаем');
      return res.sendStatus(200);
    }

    // Очищаем HTML
    const cleanText = decodeHtmlEntities(commentText);

    // Формируем сообщение
    let messageToSend = cleanText;
    if (attachments && attachments.length > 0) {
      const fileNames = attachments.map(a => a.name || 'файл').join(', ');
      if (cleanText) {
        messageToSend = `${cleanText}\n\nФайлы: ${fileNames}`;
      } else {
        messageToSend = `Файлы: ${fileNames}`;
      }
    }

    if (!messageToSend) {
      console.warn('⚠️ После обработки сообщение пустое');
      return res.sendStatus(200);
    }

    // Защита от дублирования
    const messageKey = `${taskId}_${messageToSend.substring(0, 50)}`;
    if (processedMessages.has(messageKey)) {
      console.log(`⚠️ Дублирующее сообщение для задачи ${taskId}, пропускаем`);
      return res.sendStatus(200);
    }
    processedMessages.add(messageKey);
    if (processedMessages.size > 1000) {
      const arr = Array.from(processedMessages);
      processedMessages.clear();
      arr.slice(-500).forEach(k => processedMessages.add(k));
    }

    console.log(`📤 Отправляем сообщение пользователю ${amoUserId}: ${messageToSend}`);
    await amo.sendMessage(amoUserId, messageToSend);
    console.log('✅ Сообщение успешно отправлено в amoMessenger');

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Планфикс:', err.message);
    res.sendStatus(200);
  }
});

// Проверка
app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
});
