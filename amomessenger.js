// ============================================================
//  МОДУЛЬ РАБОТЫ С amoMessenger
//  Основано на официальном туториале и примерах кода
//  (webhook.php, amo_authorization.php) с портала разработчика.
// ============================================================
 
const axios = require('axios');
 
const ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN; // токен вашего приложения-бота
const API_BASE_URL = process.env.AMO_API_BASE_URL; // адрес API для методов вроде sendMessage
const CLIENT_ID = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI = process.env.AMO_REDIRECT_URI; // тот же адрес /oauth, что указан в кабинете разработчика
 
// Сервер авторизации amoMessenger — ОТДЕЛЬНЫЙ домен, не путать
// с API_BASE_URL, который используется для отправки сообщений
const OAUTH_BASE_URL = 'https://id.amo.tm';
 
// -----------------------------------------------------------
// Обмен временного кода (?code=...) на постоянный access_token
// -----------------------------------------------------------
// Взято из официального туториала amoMessenger. Токен запрашивается
// как обычная веб-форма (не JSON!), поэтому используем querystring.
async function exchangeCodeForToken(code) {
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('redirect_uri', REDIRECT_URI);
  params.append('code', code);
 
  const res = await axios.post(
    `${OAUTH_BASE_URL}/oauth2/access_token`,
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
 
  return res.data; // { access_token, refresh_token, expires_in, ... }
}
 
// -----------------------------------------------------------
// Узнаём "контекст" токена: от имени какого пользователя/компании
// он выдан. Полезно, чтобы понимать, кто установил приложение.
// -----------------------------------------------------------
async function validateToken(accessToken) {
  const res = await axios.get(`${OAUTH_BASE_URL}/oauth2/validate`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  return res.data; // { user_uuid, company_uuid, client_uuid }
}
 
// -----------------------------------------------------------
// Разбор входящего сообщения (то, что amoMessenger присылает
// на наш /webhook/amomessenger при получении сообщения)
// -----------------------------------------------------------
function parseIncomingMessage(body) {
  // Реальная структура вебхука amoMessenger (из официального
  // примера webhook.php):
  // body._embedded.message               — само сообщение
  // body._embedded.conversation_identity — "адрес" переписки,
  //                                        нужен для ответа
  // body._embedded.context.company_id    — id компании
  const message = body?._embedded?.message || {};
  const conversationIdentity = body?._embedded?.conversation_identity || {};
 
  return {
    // Именно conversation_identity.direct_id используется потом
    // в адресе запроса на отправку сообщения (см. sendMessage).
    // Поэтому храним его в Планфикс как "amoMessenger ID".
    userId: conversationIdentity.direct_id,
    userName: message.author?.name || message.from?.name || null,
    text: message.text,
    messageId: message.id,
    conversationIdentity,
    raw: body,
  };
}
 
// -----------------------------------------------------------
// Отправка сообщения пользователю amoMessenger
// -----------------------------------------------------------
// Точный формат из официального примера (webhook.php):
//   POST https://api.amo.io/v1.3/direct/{direct_id}/sendMessage
//   body: { text }  (либо ещё attachments/reply_to при желании)
// {direct_id} — это то же значение, что мы сохранили как
// "amoMessenger ID" в задаче Планфикс (userId из parseIncomingMessage).
async function sendMessage(directId, text) {
  const url = `${API_BASE_URL}/direct/${directId}/sendMessage`;
 
  const body = { text };
 
  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
 
  return res.data;
}
 
module.exports = {
  parseIncomingMessage,
  sendMessage,
  exchangeCodeForToken,
  validateToken,
};
 
