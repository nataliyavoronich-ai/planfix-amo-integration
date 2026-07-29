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
      <p>Скопируйте этот токен и вставьте его в переменную окружения <strong>AMO_ACCESS_TOKEN</strong> на Render, затем перезапустите сервис.</p>
      <p>Refresh токен: <code>${tokenData.refresh_token}</code> (сохраните его для обновления)</p>
    `);
  } catch (err) {
    console.error('❌ Ошибка при обмене кода:');
    res.status(500).send('Не удалось получить токен. Посмотрите логи на Render для деталей.');
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

    // Получаем реальное имя пользователя
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

    // Ищем контакт (сначала по задаче, потом по имени)
    const contactId = await planfix.findOrCreateContactId(userId, realUserName);
    console.log(`✅ Контакт ID: ${contactId}`);

    // Ищем открытую задачу по контакту
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
    // 1. Пытаемся взять amoUserId из тела запроса
    let amoUserId = req.body.amoUserId || null;
    let commentText = req.body.commentText || req.body.comment || req.body.text || req.body.message || req.body.description;

    // 2. Если amoUserId не пришёл, получаем из задачи по заголовку
    if (!amoUserId) {
      const taskId = req.headers['x-planfix-task'];
      if (taskId) {
        console.log(`🔍 Получаем amoUserId для задачи ${taskId} через API...`);
        amoUserId = await planfix.getAmoUserIdFromTask(taskId);
      } else {
        console.warn('⚠️ Заголовок x-planfix-task отсутствует');
      }
    }

    if (!amoUserId) {
      console.warn('⚠️ Не удалось найти amoUserId');
      return res.sendStatus(200);
    }

    if (!commentText) {
      console.warn('⚠️ Не удалось извлечь текст комментария. Доступные поля:', Object.keys(req.body));
      return res.sendStatus(200);
    }

    // ОЧИЩАЕМ HTML-ТЕГИ из комментария
    const cleanText = commentText.replace(/<[^>]*>/g, '').trim();
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

// Проверка работоспособности
app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
});
