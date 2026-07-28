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
  // Проверяем, что все необходимые переменные заданы
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    throw new Error('Отсутствуют переменные окружения: CLIENT_ID, CLIENT_SECRET или REDIRECT_URI');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('redirect_uri', REDIRECT_URI);
  params.append('code', code);

  // Логируем, что отправляем (но скрываем секретный код и секрет частично)
  console.log('Отправляем запрос на обмен токена:');
  console.log('  grant_type = authorization_code');
  console.log('  client_id =', CLIENT_ID);
  console.log('  client_secret =', CLIENT_SECRET.slice(0, 6) + '...' + CLIENT_SECRET.slice(-4));
  console.log('  redirect_uri =', REDIRECT_URI);
  console.log('  code =', code.slice(0, 10) + '... (скрыто)');

  try {
    const res = await axios.post(
      `${OAUTH_BASE_URL}/oauth2/access_token`,
      params,
      { 
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        } 
      }
    );
    console.log('✅ Токен успешно получен');
    return res.data;
  } catch (err) {
    // ПОДРОБНЫЙ ВЫВОД ОШИБКИ
    console.error('❌ Ошибка обмена кода на токен:');
    if (err.response) {
      console.error('  Статус:', err.response.status);
      console.error('  Заголовки:', err.response.headers);
      console.error('  Тело ответа (причина):', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('  Сообщение:', err.message);
    }
    throw err;
  }
}

// -----------------------------------------------------------
// Проверка контекста токена
// -----------------------------------------------------------
async function validateToken(accessToken) {
  const res = await axios.get(`${OAUTH_BASE_URL}/oauth2/validate`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  return res.data;
}

// -----------------------------------------------------------
// Разбор входящего сообщения от amoMessenger
// -----------------------------------------------------------
function parseIncomingMessage(body) {
  // Если тело пришло как строка, пытаемся разобрать JSON
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch (e) {
      data = body;
    }
  }

  // Универсальный парсинг – пробуем разные возможные поля
  const userId = data.from?.id || data.userId || data.sender_id || data.user_id;
  const userName = data.from?.name || data.userName || data.sender_name || data.user_name;
  const text = data.message?.text || data.text || data.message;

  return {
    userId,
    userName,
    text,
    raw: data,
  };
}

// -----------------------------------------------------------
// Отправка сообщения пользователю
// -----------------------------------------------------------
async function sendMessage(userId, text) {
  const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
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
