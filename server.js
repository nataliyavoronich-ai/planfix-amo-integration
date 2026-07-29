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
// Вебхук от amoMessenger (входящие сообщения)
// -----------------------------------------------------------
app.post('/webhook/amomessenger', checkSecret, async (req, res) => {
  // Логируем полный body для отладки
  console.log('📩 Полный body от amoMessenger:', JSON.stringify(req.body, null, 2));

  try {
    // Парсим входящее сообщение
    const { userId, userName, text, raw } = amo.parseIncomingMessage(req.body);

    console.log('Входящее сообщение от', userId, ':', text);

    if (!userId || !text) {
      console.log('Пустое сообщение или нет ID пользователя, игнорируем');
      return res.sendStatus(200);
    }

    // --- ПОЛУЧАЕМ РЕАЛЬНОЕ ИМЯ ПОЛЬЗОВАТЕЛЯ ---
    let realUserName = userName;
    // Если имя не пришло в вебхуке или равно запасному, запрашиваем через API
    if (!realUserName || realUserName.startsWith('Пользователь ') || realUserName === userId) {
      console.log(`👤 Имя пользователя не получено из вебхука, запрашиваем через API...`);
      const nameFromApi = await amo.getUserInfo(userId);
      if (nameFromApi) {
        realUserName = nameFromApi;
        console.log(`✅ Имя получено из API: ${realUserName}`);
      } else {
        // Если API не вернул имя, используем ID как запасной вариант
        realUserName = userId;
        console.log(`⚠️ Не удалось получить имя, используем ID: ${realUserName}`);
      }
    }

    // --- РАБОТА С КОНТАКТОМ И ЗАДАЧЕЙ ---
    // Находим или создаём контакт (с обновлением имени, если оно изменилось)
    const contactId = await planfix.findOrCreateContactId(userId, realUserName);

    // Ищем открытую задачу для этого контакта
    const openTask = await planfix.findOpenTaskByContactId(contactId);

    if (openTask) {
      // Добавляем комментарий в существующую задачу
      await planfix.addComment(openTask.id, text);
      console.log('➕ Комментарий добавлен в задачу #' + openTask.id);
    } else {
      // Создаём новую задачу
      const newTask = await planfix.createTask({
        contactId,
        amoUserId: userId,
        amoUserName: realUserName,
        text,
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
// Вебхук от Planfix (ответы из задач)
// -----------------------------------------------------------
app.post('/webhook/planfix', checkSecret, async (req, res) => {
  try {
    const { amoUserId, commentText } = req.body;

    if (!amoUserId || !commentText) {
      console.log('Нет amoUserId или commentText в запросе Planfix:', req.body);
      return res.sendStatus(200);
    }

    await amo.sendMessage(amoUserId, commentText);
    console.log('📤 Ответ отправлен пользователю', amoUserId);

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Planfix:', err.message);
    res.sendStatus(500);
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
