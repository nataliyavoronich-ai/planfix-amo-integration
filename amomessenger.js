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
const API_BASE_URL = process.env.AMO_API_BASE_URL; // адрес API, укажут в кабинете разработчика

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
async function sendMessage(userId, text) {
  // TODO: замените URL метода и структуру тела запроса на те,
  // что указаны в документации метода "отправка сообщения"
  // в личном кабинете разработчика amoMessenger.
  const url = `${API_BASE_URL}/messages`; // пример, скорее всего адрес другой

  const body = {
    to: userId,
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
};
