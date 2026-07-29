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
// OAuth callback для получения токена amoMessenger
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
    console.log('  refresh_token:', tokenData.refresh_token);
    console.log('  expires_in:', tokenData.expires_in);

    const context = await amo.validateToken(tokenData.access_token);
    console.log('Контекст токена (кто установил приложение):', context);

    res.send(`
      <h2>Приложение успешно подключено!</h2>
      <p>Токен: <code>${tokenData.access_token}</code></p>
      <p>Скопируйте этот токен и вставьте его в переменную окружения <strong>AMO_ACCESS_TOKEN</strong> на Render, затем перезапустите сервис.</p>
      <p>Refresh токен: <code>${tokenData.refresh_token}</code> (сохраните его для обновления)</p>
    `);
  } catch (err) {
    console.error('❌ Ошибка при обмене кода:');
    res.status(500).send('Не удалось получить токен. Посмотрите логи на Render для деталей.');
  }
});

// -----------------------------------------------------------
// Вебхук от amoMessenger (входящие сообщения + вложения)
// -----------------------------------------------------------
app.post('/webhook/amomessenger', checkSecret, async (req, res) => {
  console.log('📩 Полный body от amoMessenger:', JSON.stringify(req.body, null, 2));

  try {
    const { userId, userName, text, attachments, raw } = amo.parseIncomingMessage(req.body);

    let messageText = text;
    if (!messageText && attachments && attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      messageText = `📎 Вложения: ${names}`;
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

    const contactId = await planfix.findOrCreateContactId(userId, realUserName);
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
  console.log('  Query:', req.query);
  console.log('  Params:', req.params);

  try {
    let amoUserId = null;
    let commentText = null;

    // Пытаемся извлечь amoUserId из разных возможных мест
    if (req.body.amoUserId) {
      amoUserId = req.body.amoUserId;
    } else if (req.body.userId) {
      amoUserId = req.body.userId;
    } else if (req.body.contactId) {
      amoUserId = req.body.contactId;
    } else if (req.body.data && req.body.data.amoUserId) {
      amoUserId = req.body.data.amoUserId;
    } else if (req.body.customFields && Array.isArray(req.body.customFields)) {
      const field = req.body.customFields.find(f => f.fieldId === process.env.PLANFIX_AMO_CONTACT_FIELD_ID);
      if (field) amoUserId = field.value;
    }

    // Извлечение текста комментария
    if (req.body.commentText) {
      commentText = req.body.commentText;
    } else if (req.body.comment) {
      commentText = req.body.comment;
    } else if (req.body.text) {
      commentText = req.body.text;
    } else if (req.body.message) {
      commentText = req.body.message;
    } else if (req.body.description) {
      commentText = req.body.description;
    } else if (req.body.commentData && req.body.commentData.text) {
      commentText = req.body.commentData.text;
    }

    if (!amoUserId || !commentText) {
      console.warn('⚠️ Не удалось извлечь amoUserId или commentText из запроса Планфикса.');
      console.warn('  Доступные поля:', Object.keys(req.body));
      return res.sendStatus(200);
    }

    console.log(`📤 Отправляем сообщение пользователю ${amoUserId}: ${commentText}`);
    await amo.sendMessage(amoUserId, commentText);
    console.log('✅ Сообщение успешно отправлено в amoMessenger');

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Планфикс:', err.message);
    res.sendStatus(200); // всегда отвечаем 200, чтобы Планфикс не переотправлял
  }
});

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
