// ============================================================
//  МОДУЛЬ РАБОТЫ С amoMessenger
// ============================================================

const axios = require('axios');
const FormData = require('form-data');

const API_BASE_URL = process.env.AMO_API_BASE_URL || 'https://api.amo.io/v1.3';
const CLIENT_ID = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI = process.env.AMO_REDIRECT_URI;

const OAUTH_BASE_URL = 'https://id.amo.tm';

// ============================================================
//  АВТООБНОВЛЕНИЕ ТОКЕНА
//  Токен живёт 24 часа. Храним его в памяти (не в env-переменной
//  напрямую), а по расписанию обновляем через refresh_token,
//  чтобы не приходилось переустанавливать приложение вручную.
// ============================================================
let currentAccessToken = process.env.AMO_ACCESS_TOKEN || null;
let currentRefreshToken = process.env.AMO_REFRESH_TOKEN || null;

function getAccessToken() {
  return currentAccessToken;
}

// Обновляет access_token через refresh_token. Вызывается сама
// по расписанию, а также один раз сразу при запуске сервера.
async function refreshAccessToken() {
  if (!currentRefreshToken) {
    console.warn('⚠️ Нет refresh_token — автообновление невозможно, используется текущий AMO_ACCESS_TOKEN как есть');
    return;
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️ Нет AMO_CLIENT_ID/AMO_CLIENT_SECRET — автообновление невозможно');
    return;
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('refresh_token', currentRefreshToken);

  try {
    const res = await axios.post(
      `${OAUTH_BASE_URL}/oauth2/access_token`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    currentAccessToken = res.data.access_token;
    // refresh_token тоже обычно обновляется новым значением
    if (res.data.refresh_token) {
      currentRefreshToken = res.data.refresh_token;
    }
    console.log('🔄 Токен amoMessenger автоматически обновлён, действителен ещё', res.data.expires_in, 'секунд');
  } catch (err) {
    console.error('❌ Не удалось автоматически обновить токен:', err.response?.data || err.message);
  }
}

// Запускаем: сразу при старте сервера (на случай, если сохранённый
// AMO_ACCESS_TOKEN уже устарел) и затем каждые 12 часов.
function startTokenAutoRefresh() {
  if (currentRefreshToken) {
    refreshAccessToken();
  }
  setInterval(refreshAccessToken, 12 * 60 * 60 * 1000); // каждые 12 часов
}

// -----------------------------------------------------------
// Обмен временного кода на постоянный access_token (при установке приложения)
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

  try {
    const res = await axios.post(
      `${OAUTH_BASE_URL}/oauth2/access_token`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    // Запоминаем оба токена в памяти сразу же — дальше сервер
    // сам будет обновлять access_token по расписанию.
    currentAccessToken = res.data.access_token;
    currentRefreshToken = res.data.refresh_token;
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
      headers: { Authorization: `Bearer ${getAccessToken()}` },
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
// Отправка текстового сообщения (без файлов)
// -----------------------------------------------------------
async function sendMessage(userId, text) {
  const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
  const res = await axios.post(url, { text }, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  return res.data;
}

// -----------------------------------------------------------
// Скачивание файла по URL
// -----------------------------------------------------------
async function downloadFile(url) {
  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
    });
    return response.data; // stream
  } catch (err) {
    console.error('❌ Ошибка скачивания файла:', err.message);
    throw err;
  }
}

// -----------------------------------------------------------
// Загрузка файла в amoMessenger (через API upload)
// -----------------------------------------------------------
async function uploadFileToAmo(fileStream, fileName) {
  const form = new FormData();
  form.append('file', fileStream, { filename: fileName });

  // ВАЖНО: у этого конкретного метода отдельный домен — api.amo.tm,
  // а не api.amo.io, который используется для sendMessage и остального.
  // Подтверждено официальной документацией amoMessenger.
  const url = 'https://api.amo.tm/v1.3/files/upload';
  try {
    const res = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${getAccessToken()}`,
      },
    });
    console.log('✅ Файл загружен в amoMessenger:', res.data);
    return res.data.file_id;
  } catch (err) {
    console.error('❌ Ошибка загрузки файла в amoMessenger:', err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------------
// Отправка сообщения с вложением (файлом)
// -----------------------------------------------------------
async function sendMessageWithFile(userId, text, fileUrl, fileName) {
  try {
    // 1. Скачиваем файл
    const fileStream = await downloadFile(fileUrl);

    // 2. Загружаем в amoMessenger
    const fileId = await uploadFileToAmo(fileStream, fileName);
    if (!fileId) {
      throw new Error('Не удалось получить ID загруженного файла');
    }

    // 3. Отправляем сообщение с вложением
    const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
    const payload = {};
    if (text) payload.text = text;
    // Судя по ошибке валидации amoMessenger ("MessageRequest.attachments"),
    // поле называется "attachments", а не "file_id". Точный формат внутри
    // объекта не подтверждён документацией — пробуем самый вероятный
    // вариант (массив объектов с file_id). Если снова будет ошибка
    // валидации — пришлите точный текст ошибки, поправим по нему.
    payload.attachments = [{ file_id: fileId }];

    console.log('📤 Отправляем payload в amoMessenger:', JSON.stringify(payload, null, 2));
    const res = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${getAccessToken()}` },
    });
    console.log('✅ Сообщение с файлом отправлено');
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка отправки сообщения с файлом:', err.message);
    if (err.response) {
      console.error('  Статус:', err.response.status);
      console.error('  Данные:', JSON.stringify(err.response.data, null, 2));
    }
    // Если не удалось отправить с файлом – пробуем только текст
    if (text) {
      console.log('📤 Отправляем только текст как fallback');
      await sendMessage(userId, text);
    }
    throw err;
  }
}

// -----------------------------------------------------------
// Универсальная отправка сообщения (с файлами или без)
// -----------------------------------------------------------
async function sendMessageWithAttachments(userId, text, attachments = []) {
  if (!attachments || attachments.length === 0) {
    return sendMessage(userId, text);
  }

  const first = attachments[0];
  if (first && first.url) {
    const fileName = first.name || 'file';
    return sendMessageWithFile(userId, text, first.url, fileName);
  }

  return sendMessage(userId, text);
}

module.exports = {
  parseIncomingMessage,
  sendMessage,
  sendMessageWithAttachments,
  exchangeCodeForToken,
  validateToken,
  getUserInfo,
  startTokenAutoRefresh,
};
