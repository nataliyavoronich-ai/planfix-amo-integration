// ============================================================
//  ГЛАВНЫЙ ФАЙЛ СЕРВЕРА
//  Обрабатывает входящие вебхуки от amoMessenger и Planfix
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
    console.warn('⚠️ Неверный секрет в запросе:', req.query.secret);
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

// Хранилище для предотвращения дублирования исходящих сообщений
const processedMessages = new Set();

// --- Кеш для ожидания файлов ---
// Храним { taskId: { text, timer, resolved } }
const pendingTexts = new Map();

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
    res.send(`
      <h2>Приложение подключено!</h2>
      <p>Токен: <code>${tokenData.access_token}</code></p>
      <p>Скопируйте его и вставьте в переменную окружения <strong>AMO_ACCESS_TOKEN</strong> на Render, затем перезапустите сервис.</p>
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
      console.log('Пустое сообщение, игнорируем');
      return res.sendStatus(200);
    }

    let realUserName = userName;
    if (!realUserName || realUserName.startsWith('Пользователь ') || realUserName === userId) {
      const nameFromApi = await amo.getUserInfo(userId);
      realUserName = nameFromApi || userId;
      console.log(`👤 Имя пользователя: ${realUserName}`);
    }

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
// Вебхук от Planfix (исходящие ответы и уведомления)
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
    if (req.body.amoUserId) {
      amoUserId = req.body.amoUserId;
    } else if (req.body.chatId) {
      amoUserId = req.body.chatId;
    }

    if (!amoUserId && taskId) {
      console.log(`🔍 Получаем amoUserId для задачи ${taskId} через API...`);
      amoUserId = await planfix.getAmoUserIdFromTask(taskId);
    }

    if (!amoUserId) {
      console.warn('⚠️ amoUserId не найден, пропускаем');
      return res.sendStatus(200);
    }

    // --- ИЗВЛЕКАЕМ ТЕКСТ ---
    commentText = req.body.commentText || req.body.comment || req.body.text || req.body.message || req.body.description || '';

    // --- ИЗВЛЕКАЕМ ВЛОЖЕНИЯ ---
    if (req.body.attachments) {
      if (Array.isArray(req.body.attachments)) {
        attachments = req.body.attachments;
      } else if (typeof req.body.attachments === 'object') {
        if (req.body.attachments.url && req.body.attachments.name) {
          attachments.push({ name: req.body.attachments.name, url: req.body.attachments.url });
        } else {
          const keys = Object.keys(req.body.attachments).filter(k => !isNaN(k));
          attachments = keys.map(k => req.body.attachments[k]);
        }
      }
    }

    // Очищаем HTML
    const cleanText = decodeHtmlEntities(commentText);

    // --- ЛОГИКА ОБЪЕДИНЕНИЯ ТЕКСТА И ФАЙЛА ---
    const hasAttachments = attachments && attachments.length > 0;
    const hasText = cleanText && cleanText.length > 0;

    // Если есть вложения – это основной запрос (с файлом)
    if (hasAttachments) {
      // Проверяем, не ждём ли мы текст для этой задачи
      if (taskId && pendingTexts.has(taskId)) {
        const pending = pendingTexts.get(taskId);
        console.log(`ℹ️ Найден ожидающий текст для задачи ${taskId}: "${pending.text}", объединяем с файлом`);
        clearTimeout(pending.timer);
        pendingTexts.delete(taskId);
        // Отправляем с объединённым текстом
        const finalText = pending.text || cleanText;
        await sendMessageWithAttachmentsAndDedup(amoUserId, finalText, attachments, taskId);
      } else {
        // Отправляем с текущим текстом (если есть)
        await sendMessageWithAttachmentsAndDedup(amoUserId, cleanText, attachments, taskId);
      }
    } else if (hasText) {
      // Если есть только текст – откладываем отправку, чтобы дождаться файла
      if (taskId) {
        // Если уже есть ожидающий текст для этой задачи, обновляем его (берём последний)
        if (pendingTexts.has(taskId)) {
          console.log(`ℹ️ Обновляем ожидающий текст для задачи ${taskId} на "${cleanText}"`);
          clearTimeout(pendingTexts.get(taskId).timer);
          pendingTexts.delete(taskId);
        }
        console.log(`⏳ Откладываем отправку текста для задачи ${taskId} на 1 секунду`);
        const timer = setTimeout(() => {
          // Таймер сработал – файл не пришёл, отправляем текст
          if (pendingTexts.has(taskId)) {
            const pending = pendingTexts.get(taskId);
            console.log(`⏰ Таймаут для задачи ${taskId}, отправляем текст: "${pending.text}"`);
            pendingTexts.delete(taskId);
            // Отправляем текст (без файла)
            sendMessageWithAttachmentsAndDedup(amoUserId, pending.text, [], taskId).catch(err => {
              console.error('❌ Ошибка отправки текста по таймауту:', err.message);
            });
          }
        }, 1000); // ждём 1 секунду
        pendingTexts.set(taskId, { text: cleanText, timer });
      } else {
        // Если нет taskId – отправляем сразу (например, если пришёл JSON без taskId, но такое бывает)
        await sendMessageWithAttachmentsAndDedup(amoUserId, cleanText, [], taskId);
      }
    } else {
      // Нет ни текста, ни вложений
      console.warn('⚠️ Нет текста комментария и вложений, пропускаем');
      return res.sendStatus(200);
    }

    // Всегда отвечаем 200, чтобы Планфикс не переотправлял
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Планфикс:', err.message);
    if (err.response) {
      console.error('  Статус:', err.response.status);
      console.error('  Данные:', JSON.stringify(err.response.data, null, 2));
    }
    res.sendStatus(200);
  }
});

// -----------------------------------------------------------
// ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ОТПРАВКИ С ДЕДУПЛИКАЦИЕЙ
// -----------------------------------------------------------
async function sendMessageWithAttachmentsAndDedup(amoUserId, text, attachments, taskId) {
  // Очищаем текст от HTML (повторно, на всякий случай)
  const cleanText = decodeHtmlEntities(text);
  const idForDedup = taskId || amoUserId;
  const messageKey = `${idForDedup}_${cleanText.substring(0, 50)}`;
  if (processedMessages.has(messageKey)) {
    console.log(`⚠️ Дублирующее сообщение для ${idForDedup}, пропускаем`);
    return;
  }
  processedMessages.add(messageKey);
  if (processedMessages.size > 1000) {
    const arr = Array.from(processedMessages);
    processedMessages.clear();
    arr.slice(-500).forEach(k => processedMessages.add(k));
  }

  console.log(`📤 Отправляем сообщение пользователю ${amoUserId} с ${attachments.length} вложением(ями), текст: "${cleanText}"`);
  await amo.sendMessageWithAttachments(amoUserId, cleanText, attachments);
  console.log('✅ Сообщение успешно отправлено в amoMessenger');
}

// -----------------------------------------------------------
// Проверка работоспособности
// -----------------------------------------------------------
app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
});
