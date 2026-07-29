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
    throw new Error('Отсутствуют переменные окружения: CLIENT_ID, CLIENT_SECRET или REDIRECT_URI');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('redirect_uri', REDIRECT_URI);
  params.append('code', code);

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
// Получение информации о пользователе по его UUID
// -----------------------------------------------------------
async function getUserInfo(userUuid) {
  if (!userUuid) {
    console.warn('⚠️ getUserInfo вызван без userUuid');
    return null;
  }

  try {
    const url = `https://api.amo.io/v1.0/users/${userUuid}`;
    console.log(`🔍 Запрашиваем информацию о пользователе ${userUuid}...`);
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Accept': 'application/json',
      },
    });

    const userName = response.data?.name || null;
    console.log(`✅ Получено имя пользователя: ${userName}`);
    return userName;
  } catch (error) {
    console.error(`❌ Ошибка при получении информации о пользователе ${userUuid}:`, error.message);
    if (error.response) {
      console.error('  Статус:', error.response.status);
      console.error('  Данные:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

// -----------------------------------------------------------
// Разбор входящего сообщения от amoMessenger (с вложениями)
// -----------------------------------------------------------
function parseIncomingMessage(body) {
  const message = body?._embedded?.message;
  const author = message?.author;
  const userId = author?.user_id;
  const text = message?.text || '';

  let attachments = [];
  if (message?.attachments && Array.isArray(message.attachments)) {
    attachments = message.attachments.map(file => {
      let name = null;
      let url = null;
      // Проверяем возможные типы вложений
      if (file.photo) {
        name = file.photo.filename;
        url = file.photo.link;
      } else if (file.file) {
        name = file.file.filename;
        url = file.file.link;
      } else if (file.video) {
        name = file.video.filename;
        url = file.video.link;
      } else if (file.audio) {
        name = file.audio.filename;
        url = file.audio.link;
      } else if (file.document) {
        name = file.document.filename;
        url = file.document.link;
      } else {
        // fallback: ищем любые поля с filename и link
        for (const key of ['photo', 'file', 'video', 'audio', 'document']) {
          if (file[key] && file[key].filename && file[key].link) {
            name = file[key].filename;
            url = file[key].link;
            break;
          }
        }
      }
      return { name: name || 'file', url: url || '' };
    });
  }

  // fallback на случай других структур
  if (attachments.length === 0 && body?.attachments) {
    attachments = body.attachments.map(file => ({
      name: file.name || file.filename || 'file',
      url: file.url || file.link || '',
    }));
  }

  return {
    userId,
    userName: undefined,
    text,
    attachments,
    raw: body,
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
  getUserInfo,
};
