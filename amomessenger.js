// ============================================================
//  МОДУЛЬ РАБОТЫ С amoMessenger
//
//  ВАЖНО ДЛЯ ВАС:
//  API amoMessenger закрытый — доступ к точной документации
//  открывается только после регистрации партнёром на портале
//  https://developers.amo.tm  (см. README.md, шаг 4).
//
//  Поэтому ниже — рабочий каркас (структура) с местами,
//  помеченными как TODO. Их нужно заполнить точными
//  названиями полей и адресами методов из вашего личного
//  кабинета разработчика (там будет пример запроса и ответа
//  прямо на понятном языке, как в конструкторе).
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
  // TODO: замените поля ниже на реальные названия из вебхука
  // amoMessenger. Проще всего это сделать так:
  //  1. Временно замените "return {...}" на "console.log(body); return {};"
  //  2. Разверните сервер, напишите боту тестовое сообщение
  //  3. Посмотрите в логах сервера (Render -> Logs), какие
  //     поля реально пришли, и впишите их сюда.
  return {
    userId: body.from?.id || body.userId || body.sender_id,
    userName: body.from?.name || body.userName || body.sender_name,
    text: body.message?.text || body.text,
    raw: body,
  };
}
 
// -----------------------------------------------------------
// Отправка сообщения пользователю amoMessenger
// -----------------------------------------------------------
// Реальный метод (из документации amoMessenger):
//   POST https://api.amo.io/v1.3/direct/{USER_ID}/sendMessage
// {USER_ID} — это ID получателя (того, кто писал боту),
// подставляется прямо в адрес запроса, а не в тело.
// В .env для AMO_API_BASE_URL укажите: https://api.amo.io/v1.3
async function sendMessage(userId, text) {
  const url = `${API_BASE_URL}/direct/${userId}/sendMessage`;
 
  // TODO: сверьте название поля с текстом сообщения по примеру
  // запроса в документации — ниже наиболее вероятный вариант.
  const body = {
    text,
  };
 
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
 
