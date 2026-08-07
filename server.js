// ============================================================
//  ГЛАВНЫЙ ФАЙЛ СЕРВЕРА
//  Обрабатывает входящие вебхуки от amoMessenger и Planfix
// ============================================================

require('dotenv').config();
const express = require('express');
const planfix = require('./planfix');
const amo = require('./amomessenger');

const app = express();

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
// Защита от повторной обработки ОДНОГО И ТОГО ЖЕ сообщения
// от Планфикс — используем messageId, который Планфикс присылает
// в каждой команде newMessage (это надёжнее, чем сравнивать текст).
// -----------------------------------------------------------
const seenPlanfixMessageIds = new Set();
function isDuplicatePlanfixMessage(messageId) {
  if (!messageId) return false; // если ID вдруг не пришёл — не блокируем, лучше отправить лишний раз, чем ни разу
  if (seenPlanfixMessageIds.has(messageId)) return true;
  seenPlanfixMessageIds.add(messageId);
  if (seenPlanfixMessageIds.size > 2000) {
    // не даём множеству расти бесконечно
    const arr = Array.from(seenPlanfixMessageIds);
    seenPlanfixMessageIds.clear();
    arr.slice(-1000).forEach((id) => seenPlanfixMessageIds.add(id));
  }
  return false;
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
    console.log('✅ Получен refresh_token:', tokenData.refresh_token);
    const context = await amo.validateToken(tokenData.access_token);
    console.log('Контекст:', context);
    res.send(`
      <h2>Приложение подключено!</h2>
      <p>Токен: <code>${tokenData.access_token}</code></p>
      <p>Refresh-токен: <code>${tokenData.refresh_token}</code></p>
      <p>Вставьте оба значения в переменные окружения <strong>AMO_ACCESS_TOKEN</strong> и <strong>AMO_REFRESH_TOKEN</strong> на Render (это нужно один раз — дальше сервер будет обновлять токен сам).</p>
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
    const { userId, userName, text, attachments } = amo.parseIncomingMessage(req.body);

    let messageText = text;
    let finalAttachments = attachments;

    // Если сообщение пришло "пустым" (нет ни текста, ни вложений) —
    // пробуем догрузить полную версию по ссылке self (см. случай
    // с пересланными сообщениями).
    const selfHref = req.body?._embedded?.message?.links?.self?.href;
    if (!messageText && (!finalAttachments || finalAttachments.length === 0) && selfHref) {
      const full = await amo.getMessageDetails(selfHref);
      if (full) {
        const reparsed = amo.parseIncomingMessage({ _embedded: { message: full } });
        messageText = reparsed.text;
        finalAttachments = reparsed.attachments;
      }
    }

    if (!messageText && finalAttachments && finalAttachments.length > 0) {
      const names = finalAttachments.map((a) => a.name).join(', ');
      messageText = `Файлы: ${names}`;
    }

    console.log('Входящее сообщение от', userId, ':', messageText);

    if (!userId || (!messageText && (!finalAttachments || finalAttachments.length === 0))) {
      console.log('Пустое сообщение, игнорируем');
      return res.sendStatus(200);
    }

    let realUserName = userName;
    if (!realUserName) {
      const nameFromApi = await amo.getUserInfo(userId);
      realUserName = nameFromApi || userId;
    }

    // Единственный вызов: chatId и contactId = userId, всегда одинаковые.
    // Планфикс сам находит/создаёт нужный контакт и задачу.
    await planfix.sendMessageToPlanfix({
      amoUserId: userId,
      amoUserName: realUserName,
      text: messageText,
      attachments: finalAttachments,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки сообщения из amoMessenger:', err.message);
    res.sendStatus(500);
  }
});

// -----------------------------------------------------------
// Вебхук ОТ Планфикс (ответ специалиста поддержки в задаче)
// Формат — официальная команда newMessage из документации:
// https://planfix.com/ru/help/Список_команд_API_для_чатов
// -----------------------------------------------------------
// Планфикс отдаёт ссылки в виде "текст [ url ]" (уже без HTML-тега).
// Пробуем собрать из этого entities — по той же схеме, что amoMessenger
// использует для ВХОДЯЩИХ сообщений (симметричное предположение,
// не подтверждено документацией напрямую для исходящих).
function extractLinkEntities(text) {
  if (!text) return { cleanText: text, entities: [] };

  const entities = [];
  let cleanText = '';
  let lastIndex = 0;
  const regex = /(\S.*?)\s\[\s(https?:\/\/\S+)\s\]/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const [full, label, url] = match;
    cleanText += text.slice(lastIndex, match.index);
    const start = cleanText.length;
    cleanText += label;
    const end = cleanText.length;
    entities.push({ start, end, format: 'link', url });
    lastIndex = match.index + full.length;
  }
  cleanText += text.slice(lastIndex);

  return { cleanText, entities };
}

// Планфикс оформляет цитируемое сообщение прямо в тексте, строками
// с ">>" в начале (и добавляет одну лишнюю пустую ">>"-строку).
// Приводим к более аккуратному виду с одинарным "> ".
function cleanupPlanfixQuote(text) {
  if (!text) return text;
  let result = text.replace(/^>>\s*$/gm, '');       // убираем пустую служебную ">>"-строку
  result = result.replace(/^>>\s?/gm, '> ');          // ">> " -> "> "
  result = result.replace(/\n{3,}/g, '\n\n');         // схлопываем лишние пустые строки
  return result.trim();
}

const PLANFIX_REPLY_TOKEN = process.env.PLANFIX_WEBCHAT_REPLY_TOKEN;

// -----------------------------------------------------------
// Планфикс присылает текст комментария как HTML (у него визуальный
// редактор). Переводим базовую разметку в Markdown, который,
// судя по всему, понимает amoMessenger (жирный текст со звёздочками).
// -----------------------------------------------------------
function htmlToMarkdown(html) {
  if (!html) return html;
  let text = html;

  text = text.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  text = text.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_');
  text = text.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, url, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    return cleanLabel && cleanLabel !== url ? `${cleanLabel} (${url})` : url;
  });

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  text = text.replace(/<\/?p[^>]*>/gi, '');

  // убираем все оставшиеся теги, которые не относятся к форматированию
  text = text.replace(/<[^>]+>/g, '');

  const entities = {
    '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&',
    '&quot;': '"', '&#39;': "'", '&laquo;': '«', '&raquo;': '»',
    '&mdash;': '—', '&ndash;': '–',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }

  return text.trim();
}

app.post('/webhook/planfix', checkSecret, async (req, res) => {
  console.log('📩 Запрос от Планфикс (ответ оператора):', JSON.stringify(req.body, null, 2));

  try {
    const { cmd, chatId, token, message, messageId, attachments, userName, userLastName } = req.body;

    if (PLANFIX_REPLY_TOKEN && token !== PLANFIX_REPLY_TOKEN) {
      console.warn('⚠️ Неверный token от Планфикс, запрос отклонён');
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (cmd !== 'newMessage') {
      console.log('Команда не newMessage, игнорируем:', cmd);
      return res.sendStatus(200);
    }

    if (!chatId || (!message && !attachments)) {
      console.log('Нет chatId и нет ни текста, ни вложений в запросе от Планфикс');
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    if (isDuplicatePlanfixMessage(messageId)) {
      console.log('⚠️ Это сообщение уже было обработано (messageId=' + messageId + '), пропускаем повтор');
      return res.status(200).json({ chatId, contactId: chatId });
    }

    // Приводим вложения к единому виду: массив {name, url}
    let parsedAttachments = [];
    if (attachments) {
      if (Array.isArray(attachments)) {
        parsedAttachments = attachments;
      } else if (attachments.name && attachments.url) {
        // Одно вложение (express.urlencoded даёт объект, не массив)
        const names = Array.isArray(attachments.name) ? attachments.name : [attachments.name];
        const urls = Array.isArray(attachments.url) ? attachments.url : [attachments.url];
        parsedAttachments = names.map((name, i) => ({ name, url: urls[i] }));
      }
    }

    // Убираем служебное оформление цитаты Планфикс (">>")
    const quoteCleanedMessage = cleanupPlanfixQuote(message);
    // Планфикс присылает HTML — переводим в Markdown-разметку (на случай HTML)
    const cleanMessage = htmlToMarkdown(quoteCleanedMessage);
    // Пробуем восстановить ссылку в кликабельную форму через entities
    const { cleanText, entities } = extractLinkEntities(cleanMessage);

    // Формируем подпись с именем сотрудника Планфикс — жирным через
    // entities (а не звёздочками), т.к. amoMessenger понимает разметку
    // именно так (см. формат входящих сообщений).
    const employeeName = [userName, userLastName].filter(Boolean).join(' ').trim();
    const employeeLabel = employeeName ? `${employeeName}:` : '';
    const formattedMessage = employeeLabel
      ? `${employeeLabel}${cleanText ? '\n' + cleanText : ''}`
      : cleanText;

    // Сдвигаем позиции ссылочных entities на длину добавленной подписи
    const prefixLength = formattedMessage.length - cleanText.length;
    const shiftedLinkEntities = entities.map((e) => ({
      ...e,
      start: e.start + prefixLength,
      end: e.end + prefixLength,
    }));
    // Имя сотрудника — жирным (entity с start=0)
    const nameEntity = employeeLabel ? [{ start: 0, end: employeeLabel.length, format: 'bold' }] : [];
    const allEntities = [...nameEntity, ...shiftedLinkEntities];

    await amo.sendMessageWithAttachments(chatId, formattedMessage, parsedAttachments, allEntities);
    console.log('📤 Ответ отправлен пользователю amoMessenger', chatId);

    res.status(200).json({ chatId, contactId: chatId });
  } catch (err) {
    console.error('❌ Ошибка обработки уведомления из Planfix:', err.message);
    // Планфикс ждёт 200 при успехе; при ошибке шлём 400, чтобы не путать с "успешно доставлено"
    res.status(400).json({ error: 'Invalid parameters' });
  }
});

// -----------------------------------------------------------
// Проверка работоспособности
// -----------------------------------------------------------
app.get('/', (req, res) => {
  res.send('Интеграция работает 🚀');
});

// ВРЕМЕННЫЙ диагностический адрес — запускает обновление токена
// вручную, чтобы не ждать 12 часов и сразу увидеть результат в Logs.
// Откройте в браузере: /debug/refresh-token?secret=ВАШ_WEBHOOK_SECRET
app.get('/debug/refresh-token', checkSecret, async (req, res) => {
  await amo.refreshAccessTokenManually();
  res.send('Проверьте Logs на Render — там будет результат обновления токена.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту ' + PORT);
  amo.startTokenAutoRefresh();
});
