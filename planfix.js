// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС (Webchat API)
//
//  ГЛАВНАЯ ИДЕЯ ПОСЛЕ ИСПРАВЛЕНИЯ:
//  Мы больше НЕ ищем и не создаём контакты через REST API.
//  Вместо этого мы всегда передаём в Планфикс один и тот же
//  chatId и contactId = amoMessenger ID пользователя.
//  Планфикс сам, внутри себя, сопоставляет эти ID с нужным
//  контактом и задачей — это и есть весь смысл Webchat API.
//  Именно REST-поиск "по имени" был причиной дублей контактов.
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const WEBCHAT_TOKEN = process.env.PLANFIX_WEBCHAT_TOKEN;
const PROVIDER_ID = 'amomessenger';

const WEBCHAT_URL = `https://${ACCOUNT}.${DOMAIN}/webchat/api`;

// -----------------------------------------------------------
// Передаём сообщение пользователя (из amoMessenger) в Планфикс.
// chatId и contactId — оба равны amoUserId, ВСЕГДА одинаковые
// для одного и того же человека. Планфикс сам решает: это
// продолжение существующей задачи или нужно создать новую.
// -----------------------------------------------------------
async function sendMessageToPlanfix({ amoUserId, amoUserName, text, attachments = [] }) {
  const params = new URLSearchParams();
  params.append('cmd', 'newMessage');
  params.append('providerId', PROVIDER_ID);
  params.append('chatId', String(amoUserId));
  params.append('planfix_token', WEBCHAT_TOKEN);

  let messageText = text || '';
  if (!messageText && attachments.length > 0) {
    const names = attachments.map((a) => a.name || 'file').join(', ');
    messageText = `📎 Вложения: ${names}`;
  }
  params.append('message', messageText || 'Сообщение без текста');

  // contactId — ЭТО ЖЕ САМОЕ значение, что и chatId. Так Планфикс
  // всегда однозначно узнаёт этого человека, без поиска по имени.
  params.append('contactId', String(amoUserId));
  params.append('contactName', amoUserName || `Пользователь ${amoUserId}`);
  // ВАЖНО: title намеренно НЕ передаём. Раньше он отправлялся при каждом
  // сообщении, из-за чего Планфикс перезаписывал название задачи заново
  // на каждый ответ (добавляя "(WebChat, amoMessenger)"). Название задачи
  // теперь задаёт сам Планфикс один раз при создании, мы его не трогаем.

  attachments.forEach((file) => {
    if (file.name && file.url) {
      params.append('attachments[name]', file.name);
      params.append('attachments[url]', file.url);
    }
  });

  console.log('📤 Отправляем в Планфикс (webchat/api):', params.toString());

  try {
    const res = await axios.post(WEBCHAT_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('✅ Планфикс принял сообщение:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка при отправке в Планфикс:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  sendMessageToPlanfix,
};
