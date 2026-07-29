// ============================================================
//  МОДУЛЬ РАБОТЫ С amoMessenger
// ============================================================

const axios = require('axios');

const ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;
const API_BASE_URL = process.env.AMO_API_BASE_URL;
const CLIENT_ID = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI = process.env.AMO_REDIRECT_URI;

const OAUTH_BASE_URL = 'https://id.amo.tm';

// -----------------------------------------------------------
// Обмен временного кода на постоянный access_token
// -----------------------------------------------------------
async function exchangeCodeForToken(code) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    throw new Error('Отсутствуют переменные окружения');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('redirect_uri', REDIRECT_URI);
  params.append('code', code);

  try {
    const res = await axios.post(
      `${OAUTH_BASE_URL}/oauth2/access_token`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка обмена кода на токен:', err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------------
// Проверка контекста токена
// -----------------------------------------------------------
async function validateToken(accessToken) {
  const res = await axios.get(`${OAUTH_BASE_URL}/oauth2/validate`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

// -----------------------------------------------------------
// Получение информации о пользователе
// -----------------------------------------------------------
async function getUserInfo(userUuid) {
  if (!userUuid) return null;
  try {
    const url = `https://api.amo.io/v1.0/users/${userUuid}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    return response.data?.name || null;
  } catch (error) {
    console.error(`❌ Ошибка при получении пользователя ${userUuid}:`, error.message);
    return null;
  }
}

// -----------------------------------------------------------
// Разбор входящего сообщения с вложениями
// -----------------------------------------------------------
function parseIncomingMessage(body) {
  const message = body?._embedded?.message;
  const author = message?.author;
  const userId = author?.user_id;
  const text = message?.text || '';

  let attachments = [];
  if (message?.attachments) {
    for (const file of message.attachments) {
      if (file.type && file[file.type]) {
        const sub = file[file.type];
        const link = sub.link || sub.url || '';
        const name = sub.filename || sub.name || `${file.type}.file`;
        if (link) attachments.push({ name, url: link });
      }
    }
  }
  return { userId, userName: undefined, text, attachments, raw: body };
}

// -----------------------------------------------------------
// Отправка сообщения
// -----------------------------------------------------------
async function sendMessage(userId, text) {
  const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
  const res = await axios.post(url, { text }, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  return res.data;
}

module.exports = {
  parseIncomingMessage,
  sendMessage,
  exchangeCodeForToken,
  validateToken,
  getUserInfo,
};
