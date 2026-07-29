// ============================================================
//  ГЛАВНЫЙ ФАЙЛ СЕРВЕРА
//  Здесь два "входа":
//   1) /webhook/amomessenger  — сюда amoMessenger присылает
//      сообщение, когда сотрудник написал нашему приложению.
//   2) /webhook/planfix       — сюда Планфикс присылает
//      уведомление, когда специалист поддержки ответил в задаче.
// ============================================================
 
require('dotenv').config();
const express = require('express');
const planfix = require('./planfix');
const amo = require('./amomessenger');
 
const app = express();
app.use(express.json());
 
// Простой "секретный ключ" в адресе вебхука, чтобы посторонний
// не мог слать нам фейковые запросы. Придумайте свою строку
// и впишите её в .env в переменную WEBHOOK_SECRET.
const SECRET = process.env.WEBHOOK_SECRET;
 
function checkSecret(req, res, next) {
  if (req.query.secret !== SECRET) {
    return res.status(403).send('forbidden');
  }
  next();
}
 
// -----------------------------------------------------------
// 0. OAuth callback — сюда amoMessenger перенаправляет браузер
//    после того, как вы подтвердили установку приложения.
//    Мы забираем ?code=... и обмениваем его на access_token.
// -----------------------------------------------------------
app.get('/oauth', async (req, res) => {
  const { code } = req.query;
 
  if (!code) {
    return res.status(400).send('Не пришёл параметр code');
  }
 
  try {
    const token = await amo.exchangeCodeForToken(code);
    console.log('Получен access_token приложения:', token);
 
    const context = await amo.validateToken(token.access_token);
    console.log('Контекст токена (кто установил приложение):', context);
 
    // ВАЖНО: сейчас токен просто печатается в логах.
    // Скопируйте его оттуда (Render -> Logs) и вставьте
    // в переменную окружения AMO_ACCESS_TOKEN вручную,
    // затем перезапустите сервис на Render.
    // Токен со временем "протухает" (см. expires_in) — на
    // боевом использовании понадобится автообновление через
    // refresh_token, это отдельный следующий шаг.
 
    res.send('Приложение подключено. Токен и его контекст — смотрите Logs на Render.');
  } catch (err) {
    console.error('Ошибка обмена кода на токен:', err?.response?.data || err.message);
    res.status(500).send('Не удалось получить токен, смотрите Logs на Render');
  }
});
 
// -----------------------------------------------------------
// 1. Входящее сообщение ИЗ amoMessenger -> В Планфикс
// -----------------------------------------------------------
app.post('/webhook/amomessenger', checkSecret, async (req, res) => {
  try {
    // ВАЖНО: реальные названия полей в теле запроса нужно
    // сверить с документацией amoMessenger (личный кабинет
    // разработчика). Здесь используются условные названия —
    // поправьте их в файле amomessenger.js -> parseIncomingMessage
    const { userId, userName, text, raw } = amo.parseIncomingMessage(req.body);
 
    console.log('Входящее сообщение от', userId, ':', text);
 
    if (!userId || !text) {
      console.log('Пустое сообщение или нет ID пользователя, игнорируем');
      return res.sendStatus(200);
    }
 
    // Ищем в Планфиксе открытую (не завершённую) задачу,
    // связанную с этим пользователем amoMessenger
    const openTask = await planfix.findOpenTaskByAmoUserId(userId);
 
    if (openTask) {
      // Задача уже есть -> добавляем сообщение как комментарий
      await planfix.addComment(openTask.id, text);
      console.log('Добавлен комментарий в задачу #' + openTask.id);
    } else {
      // Задачи нет -> создаём новую
      const newTask = await planfix.createTask({
        amoUserId: userId,
        amoUserName: userName,
        text,
      });
      console.log('Создана новая задача #' + newTask.id);
    }
 
    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка обработки сообщения из amoMessenger:', err);
    res.sendStatus(500);
  }
});
 
// -----------------------------------------------------------
// 2. Ответ ИЗ Планфикса -> В amoMessenger
// -----------------------------------------------------------
// Этот адрес мы укажем в настройке "Уведомление по HTTP"
// (автоматизация) внутри Планфикса, см. README.md, шаг 6.
app.post('/webhook/planfix', checkSecret, async (req, res) => {
  try {
    // Планфикс сам формирует тело запроса по тем полям,
    // которые вы выберете при настройке уведомления.
    // Ожидаем, что придут: amoUserId (наше кастомное поле)
    // и текст комментария.
    const { amoUserId, commentText } = req.body;
 
    if (!amoUserId || !commentText) {
      console.log('Нет amoUserId или текста комментария в запросе от Планфикс:', req.body);
      return res.sendStatus(200);
    }
 
    await amo.sendMessage(amoUserId, commentText);
    console.log('Ответ отправлен пользователю', amoUserId, 'в amoMessenger');
 
    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка обработки уведомления из Планфикс:', err);
    res.sendStatus(500);
  }
});
 
// Проверочная страница — открыв её в браузере, вы поймёте,
// что сервер работает
app.get('/', (req, res) => {
  res.send('Интеграция Планфикс <-> amoMessenger работает');
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
