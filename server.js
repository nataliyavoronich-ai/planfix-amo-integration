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
    console.warn('⚠️ Неверный секрет в запросе:', req.query.secret);
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
  try {
    const tokenData = await amo.exchangeCodeForToken(code);
    console.log('✅ Получен access_token:', tokenData.access_token);
    const context = await amo.validateToken(tokenData.access_token);
    console.log('Контекст:', context);
    res.send(`
      <h2>Приложение подключено!</h2>
      <p>Токен: <code>${tokenData.access_token}</code></p>
      <p>Скопируйте его в переменную AMO_ACCESS_TOKEN на Render и перезапустите.</p>
    `);
  } catch (err) {
    console.error('❌ Ошибка OAuth:', err);
    res.status(500).send('Ошибка получения токена, смотрите логи.');
  }
});

// -----------------------------------------------------------
// Вебхук от amoMessenger
// -----------------------------------------------------------
app.post('/webhook/amomessenger', checkSecret, async (req, res) => {
  console.log('📩 Полный body от amoMessenger:', JSON.stringify(req.body, null, 2));

  try {
    const { userId, userName, text, attachments, raw } = amo.parseIncomingMessage(req.body);

    let messageText = text || '';
    if (!messageText && attachments && attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      messageText = `📎 Вложения: ${names}`;
    }

    console.log('Входящее сообщение от', userId, ':', messageText);
    if (attachments && attachments.length > 0) {
      attachments.forEach(a => console.log('  -', a.name, '=>', a.url));
    }

    if (!userId || (!messageText && (!attachments || attachments.length === 0))) {
      console.log('Пустое сообщение без содержимого, игнорируем');
      return res.sendStatus(200);
    }

    // Получаем реальное имя
    let realUserName = userName;
    if (!realUserName || realUserName.startsWith('Пользователь ')) {
      const nameFromApi = await amo.getUserInfo(userId);
      realUserName = nameFromApi || userId;
      console.log(`👤 Имя пользователя: ${realUserName}`);
    }

    console.log('🔍 Ищем/создаём контакт...');
    const contactId = await planfix.findOrCreateContactId(userId, realUserName);
    console.log('✅ ID контакта:', contactId);

    console.log('🔍 Ищем открытую задачу...');
    const openTask = await planfix.findOpenTaskByContactId(contactId);

    if (openTask) {
      console.log('➕ Добавляем комментарий в задачу #' + openTask.id);
      await planfix.addComment(openTask.id, messageText);
      console.log('✅ Комментарий добавлен');
    } else {
      console.log('🆕 Создаём новую задачу...');
      const newTask = await planfix.createTask({
        contactId,
        amoUserId: userId,
        amoUserName: realUserName,
        text: messageText,
        attachments,
      });
      console.log('✅ Задача создана:', JSON.stringify(newTask));
    }

    res.sendStatus(200);
  } catch (err) {
    // ПОДРОБНЫЙ ВЫВОД ОШИБКИ
    console.error('❌ ОШИБКА в /webhook/amomessenger:');
    console.error('  Сообщение:', err.message);
    console.error('  Стек:', err.stack);
    if (err.response) {
      console.error('  Ответ от сервера:', err.response.status, JSON.stringify(err.response.data, null, 2));
    }
    console.error('  Полный объект ошибки:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    res.sendStatus(500);
  }
});

// -----------------------------------------------------------
// Вебхук от Planfix
// -----------------------------------------------------------
app.post('/webhook/planfix', checkSecret, async (req, res) => {
  console.log('📩 Полный запрос от Планфикса:');
  console.log('  Headers:', req.headers);
  console.log('  Body:', JSON.stringify(req.body, null, 2));

  try {
    let amoUserId = null;
    let commentText = null;

    if (req.body.amoUserId) {
      amoUserId = req.body.amoUserId;
    } else if (req.body.userId) {
      amoUserId = req.body.userId;
    } else if (req.body.contactId) {
      amoUserId = req.body.contactId;
    } else if (req.body.data && req.body.data.amoUserId) {
      amoUserId = req.body.data.amoUserId;
    }

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
    }

    if (!amoUserId || !commentText) {
      console.warn('⚠️ Не удалось извлечь amoUserId или commentText. Доступные поля:', Object.keys(req.body));
      return res.sendStatus(200);
    }

    console.log(`📤 Отправляем сообщение пользователю ${amoUserId}: ${commentText}`);
    await amo.sendMessage(amoUserId, commentText);
    console.log('✅ Сообщение успешно отправлено в amoMessenger');
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ ОШИБКА в /webhook/planfix:');
    console.error('  Сообщение:', err.message);
    console.error('  Стек:', err.stack);
    if (err.response) {
      console.error('  Ответ от сервера:', err.response.status, JSON.stringify(err.response.data, null, 2));
    }
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
});
