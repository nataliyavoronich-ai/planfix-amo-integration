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

// -----------------------------------------------------------
// Upstash Redis — храним здесь САМЫЙ СВЕЖИЙ refresh_token,
// чтобы он не терялся при "засыпании"/перезапуске сервера
// на бесплатном тарифе Render.
// -----------------------------------------------------------
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = 'amo_refresh_token';

async function saveRefreshTokenToUpstash(token) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.log('ℹ️ Upstash не настроен, пропускаем сохранение');
    return;
  }
  try {
    await axios.get(`${UPSTASH_URL}/set/${UPSTASH_KEY}/${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    console.log('💾 refresh_token сохранён в Upstash');
  } catch (err) {
    console.error('❌ Не удалось сохранить refresh_token в Upstash:', err.response?.data || err.message);
  }
}

async function loadRefreshTokenFromUpstash() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.log('ℹ️ Upstash не настроен, используем переменную окружения');
    return null;
  }
  try {
    const res = await axios.get(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const token = res.data?.result || null;
    if (token) {
      console.log('📥 refresh_token загружен из Upstash');
    } else {
      console.log('ℹ️ В Upstash нет сохранённого refresh_token');
    }
    return token;
  } catch (err) {
    console.error('❌ Не удалось прочитать refresh_token из Upstash:', err.response?.data || err.message);
    return null;
  }
}

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

// Обновляет access_token через refresh_token.
async function refreshAccessToken() {
  if (!currentRefreshToken) {
    console.warn('⚠️ Нет refresh_token — автообновление невозможно, используется текущий AMO_ACCESS_TOKEN как есть');
    return;
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️ Нет AMO_CLIENT_ID/AMO_CLIENT_SECRET — автообновление невозможно');
    return;
  }

  console.log(
    `🔍 Пробуем обновить токен. refresh_token: длина=${currentRefreshToken.length}, ` +
    `начало="${currentRefreshToken.slice(0, 12)}", конец="${currentRefreshToken.slice(-12)}"`
  );

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
      // ✅ Сохраняем новый refresh_token в Upstash
      await saveRefreshTokenToUpstash(currentRefreshToken);
    }
    console.log('🔄 Токен amoMessenger автоматически обновлён, действителен ещё', res.data.expires_in, 'секунд');
  } catch (err) {
    console.error('❌ Не удалось автоматически обновить токен:', err.response?.data || err.message);
  }
}

// Запускаем: сразу при старте сервера загружаем свежий refresh_token
// из Upstash, обновляем access_token (если нужно) и затем каждые 12 часов.
async function startTokenAutoRefresh() {
  // 1. Загружаем из Upstash (если там есть)
  const savedRefreshToken = await loadRefreshTokenFromUpstash();
  if (savedRefreshToken) {
    currentRefreshToken = savedRefreshToken;
    console.log('✅ Используем refresh_token из Upstash');
  } else {
    console.log('ℹ️ Используем refresh_token из переменной окружения (или отсутствует)');
  }

  // 2. Если есть refresh_token – сразу обновляем access_token
  if (currentRefreshToken) {
    await refreshAccessToken();
  }

  // 3. Запускаем периодическое обновление (каждые 12 часов)
  setInterval(refreshAccessToken, 12 * 60 * 60 * 1000);
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
    currentAccessToken = res.data.access_token;
    currentRefreshToken = res.data.refresh_token;
    // ✅ Сохраняем полученный refresh_token в Upstash
    await saveRefreshTokenToUpstash(currentRefreshToken);
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
// Универсальная отправка сообщения (с любым числом файлов или без них).
// Текст уходит отдельным сообщением, а КАЖДЫЙ файл — отдельным
// следующим сообщением (по одному), а не всё сразу пакетом.
// Так один "неудачный" файл не мешает остальным дойти.
// -----------------------------------------------------------
async function sendMessageWithAttachments(userId, text, attachments = []) {
  if (!attachments || attachments.length === 0) {
    return sendMessage(userId, text);
  }

  const results = [];

  // 1. Текст — отдельным сообщением, если он есть
  if (text) {
    try {
      const res = await sendMessage(userId, text);
      results.push(res);
    } catch (err) {
      console.error('❌ Не удалось отправить текст:', err.response?.data || err.message);
    }
  }

  // 2. Каждый файл — отдельным сообщением
  const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
  for (const file of attachments) {
    if (!file || !file.url) continue;
    try {
      console.log(`📥 Скачиваем файл: ${file.name || file.url}`);
      const fileStream = await downloadFile(file.url);
      const fileId = await uploadFileToAmo(fileStream, file.name || 'file');
      if (!fileId) {
        console.warn(`⚠️ Файл "${file.name}" не загрузился, пропускаем`);
        continue;
      }

      const payload = { attachments: [{ file_id: fileId }] };
      console.log(`📤 Отправляем файл "${file.name}" отдельным сообщением`);
      const res = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      console.log(`✅ Файл "${file.name}" отправлен`);
      results.push(res.data);
    } catch (err) {
      console.error(`❌ Не удалось отправить файл "${file.name}":`, err.response?.data || err.message);
      // не прерываем цикл — пробуем отправить остальные файлы
    }
  }

  return results;
}

module.exports = {
  parseIncomingMessage,
  sendMessage,
  sendMessageWithAttachments,
  exchangeCodeForToken,
  validateToken,
  getUserInfo,
  startTokenAutoRefresh,
  refreshAccessTokenManually: refreshAccessToken,
};
