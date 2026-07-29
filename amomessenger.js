// ============================================================
//  МОДУЛЬ РАБОТЫ С amoMessenger
// ============================================================

const axios = require('axios');
const FormData = require('form-data');

const ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;
const API_BASE_URL = process.env.AMO_API_BASE_URL || 'https://api.amo.io/v1.3';
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
// Отправка текстового сообщения (без файлов)
// -----------------------------------------------------------
async function sendMessage(userId, text) {
  const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
  const res = await axios.post(url, { text }, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
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

  const url = `${API_BASE_URL}/files/upload`;
  try {
    const res = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    console.log('✅ Файл загружен в amoMessenger:', res.data);
    // В ответе приходит file_id (или id/attachment_id)
    return res.data.file_id || res.data.id || res.data.attachment_id;
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
    const payload = {
      text: text || '',
      files: [fileId],   // Используем поле files для вложений
    };
    const res = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    console.log('✅ Сообщение с файлом отправлено');
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка отправки сообщения с файлом:', err.message);
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

  // Обрабатываем только первое вложение (для простоты)
  const first = attachments[0];
  if (first && first.url) {
    const fileName = first.name || 'file';
    return sendMessageWithFile(userId, text, first.url, fileName);
  }

  // Если нет URL – отправляем текст
  return sendMessage(userId, text);
}

module.exports = {
  parseIncomingMessage,
  sendMessage,
  sendMessageWithAttachments,
  exchangeCodeForToken,
  validateToken,
  getUserInfo,
};
