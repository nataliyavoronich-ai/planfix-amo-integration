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
// Декодирование HTML-сущностей ( &nbsp; → пробел, &lt; → < и т.д.)
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

// Хранилище для предотвращения дублирования исходящих сообщений
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
// Вебхук от Planfix (ответы из задач → в amoMessenger)
// -----------------------------------------------------------
app.post('/webhook/planfix', checkSecret, async (req, res) => {
  console.log('📩 Полный запрос от Планфикса:');
  console.log('  Headers:', req.headers);
  console.log('  Body:', JSON.stringify(req.body, null, 2));

  try {
    const taskId = req.headers['x-planfix-task'];
    let amoUserId = req.body.amoUserId || null;
    let commentText = req.body.commentText || req.body.comment || req.body.text || req.body.message || req.body.description || '';

    // --- ИЗВЛЕКАЕМ ВЛОЖЕНИЯ ---
    let attachments = [];

    // 1. Если attachments пришли как массив
    if (req.body.attachments && Array.isArray(req.body.attachments)) {
      attachments = req.body.attachments;
    }
    // 2. Если attachments пришли как объект с индексами
    else if (req.body.attachments && typeof req.body.attachments === 'object') {
      const keys = Object.keys(req.body.attachments).filter(k => !isNaN(k));
      attachments = keys.map(k => req.body.attachments[k]);
    }

    // 3. Если вложения переданы как параметры attachments[0][name], attachments[0][url]
    const attachmentNames = {};
    const attachmentUrls = {};
    for (const key of Object.keys(req.body)) {
      const nameMatch = key.match(/^attachments\[(\d+)\]\[name\]$/);
      const urlMatch = key.match(/^attachments\[(\d+)\]\[url\]$/);
      if (nameMatch) {
        attachmentNames[nameMatch[1]] = req.body[key];
      }
      if (urlMatch) {
        attachmentUrls[urlMatch[1]] = req.body[key];
      }
    }
    // Собираем найденные вложения
    const indices = new Set([...Object.keys(attachmentNames), ...Object.keys(attachmentUrls)]);
    for (const idx of indices) {
      if (attachmentNames[idx] && attachmentUrls[idx]) {
        attachments.push({ name: attachmentNames[idx], url: attachmentUrls[idx] });
      }
    }

    // Если нет amoUserId – пытаемся получить из задачи (заглушка)
    if (!amoUserId) {
      console.warn('⚠️ amoUserId не найден в теле, пропускаем');
      return res.sendStatus(200);
    }

    // Если нет ни текста, ни вложений – пропускаем
    if (!commentText && (!attachments || attachments.length === 0)) {
      console.warn('⚠️ Нет текста комментария и вложений, пропускаем');
      return res.sendStatus(200);
    }

    // Очищаем HTML
    const cleanText = decodeHtmlEntities(commentText);

    // Формируем сообщение для отправки в amoMessenger
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
    const messageKey = `${taskId}_${commentText.substring(0, 50)}`;
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
    // Пока отправляем только текст, файлы не передаём (т.к. amoMessenger API не поддерживает их в этом методе)
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
