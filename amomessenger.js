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
// Разбор входящего сообщения от amoMessenger (все типы вложений)
// -----------------------------------------------------------
function parseIncomingMessage(body) {
  const message = body?._embedded?.message;
  const author = message?.author;
  const userId = author?.user_id;
  const text = message?.text || '';

  let attachments = [];

  if (message?.attachments && Array.isArray(message.attachments)) {
    for (const file of message.attachments) {
      // Если есть поле type и соответствующий объект (photo, voice, file, video, audio, document)
      if (file.type && file[file.type]) {
        const sub = file[file.type];
        const link = sub.link || sub.url || '';
        const name = sub.filename || sub.name || `${file.type}.file`;
        if (link) {
          attachments.push({ name, url: link });
        } else {
          console.warn('⚠️ Вложение без ссылки:', file);
        }
      } else {
        // fallback: рекурсивный поиск в объекте
        function findFileInfo(obj) {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.filename && obj.link) return { name: obj.filename, url: obj.link };
          if (obj.name && obj.url) return { name: obj.name, url: obj.url };
          if (obj.link && !obj.filename) {
            const ext = obj.link.split('.').pop().split('?')[0] || 'file';
            return { name: `file.${ext}`, url: obj.link };
          }
          for (const key of Object.keys(obj)) {
            if (Array.isArray(obj[key])) {
              for (const item of obj[key]) {
                const result = findFileInfo(item);
                if (result) return result;
              }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
              const result = findFileInfo(obj[key]);
              if (result) return result;
            }
          }
          return null;
        }
        const info = findFileInfo(file);
        if (info) {
          attachments.push(info);
        } else {
          const directName = file.name || file.filename || 'file';
          const directUrl = file.url || file.link || '';
          if (directUrl) {
            attachments.push({ name: directName, url: directUrl });
          }
        }
      }
    }
  }

  // fallback на случай, если attachments в другом месте
  if (attachments.length === 0 && body?.attachments) {
    attachments = body.attachments.map(file => {
      if (file.type && file[file.type]) {
        const sub = file[file.type];
        return { name: sub.filename || `${file.type}.file`, url: sub.link || sub.url || '' };
      }
      return { name: file.name || file.filename || 'file', url: file.url || file.link || '' };
    }).filter(a => a.url);
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
