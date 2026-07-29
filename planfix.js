// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  Использует API для чатов (webchat)
//  Документация: https://help.planfix.com/restapidocs/
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;
const CONTACT_FIELD_ID = process.env.PLANFIX_AMO_CONTACT_FIELD_ID;
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID;
const PROJECT_ID = process.env.PLANFIX_PROJECT_ID;

// Уникальный идентификатор вашей интеграции (придумайте что-то своё)
// Он не должен содержать символ "~"
const PROVIDER_ID = 'amomessenger';

// Базовый URL для API чатов
const CHAT_API_URL = `https://${ACCOUNT}.${DOMAIN}/webchat/api`;

// -----------------------------------------------------------
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (поиск контактов через REST API)
// -----------------------------------------------------------

// Создаём отдельный клиент для REST API (для поиска контактов)
const restClient = axios.create({
  baseURL: `https://${ACCOUNT}.${DOMAIN}/rest`,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
});

// Названия статусов, которые считаем "задача завершена"
const CLOSED_STATUS_WORDS = (
  process.env.PLANFIX_CLOSED_STATUS_WORDS ||
  'заверш,выполн,закрыт,отмен,done,closed,cancel'
)
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

function isClosedStatus(status) {
  if (!status || !status.name) return false;
  const name = status.name.toLowerCase();
  return CLOSED_STATUS_WORDS.some((word) => name.includes(word));
}

// -----------------------------------------------------------
// ПОИСК КОНТАКТА по amoMessenger ID (через REST API)
// -----------------------------------------------------------
async function findContactByAmoUserId(amoUserId) {
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 4101,
        field: Number(CONTACT_FIELD_ID),
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name',
  };
  const res = await restClient.post('/contact/list', body);
  console.log('RAW ОТВЕТ Планфикс при поиске контакта:', JSON.stringify(res.data, null, 2));
  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// СОЗДАНИЕ КОНТАКТА (через REST API)
// -----------------------------------------------------------
async function createContact(amoUserId, amoUserName) {
  const body = {
    template: CONTACT_TEMPLATE_ID ? { id: Number(CONTACT_TEMPLATE_ID) } : undefined,
    name: amoUserName || `amoMessenger ${amoUserId}`,
    customFieldData: [
      {
        field: { id: Number(CONTACT_FIELD_ID) },
        value: String(amoUserId),
      },
    ],
  };
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
  const res = await restClient.post('/contact/', body);
  console.log('RAW ОТВЕТ Планфикс при создании контакта:', JSON.stringify(res.data, null, 2));
  return res.data;
}

// -----------------------------------------------------------
// НАЙТИ ИЛИ СОЗДАТЬ КОНТАКТ
// -----------------------------------------------------------
async function findOrCreateContactId(amoUserId, amoUserName) {
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  }
  return contact.id;
}

// -----------------------------------------------------------
// ПОИСК ОТКРЫТОЙ ЗАДАЧИ по контакту (через REST API)
// -----------------------------------------------------------
async function findOpenTaskByContactId(contactId) {
  const body = {
    offset: 0,
    pageSize: 20,
    filters: [
      {
        type: 7,
        operator: 'equal',
        value: `contact:${contactId}`,
      },
    ],
    fields: 'id,name,status',
  };
  const res = await restClient.post('/task/list', body);
  console.log('RAW ОТВЕТ Планфикс при поиске открытой задачи:', JSON.stringify(res.data, null, 2));
  const tasks = res.data.tasks || [];
  const openTask = tasks.find((t) => !isClosedStatus(t.status));
  return openTask || null;
}

// -----------------------------------------------------------
// ОТПРАВКА СООБЩЕНИЯ В ПЛАНФИКС (через API чатов)
// Используется команда newMessage из документации
// -----------------------------------------------------------
async function createTask({ contactId, amoUserId, amoUserName, text }) {
  // Формируем параметры запроса в формате form-urlencoded
  const params = new URLSearchParams();
  params.append('cmd', 'newMessage');
  params.append('providerId', PROVIDER_ID);
  params.append('chatId', String(amoUserId)); // Используем amoUserId как chatId
  params.append('planfix_token', TOKEN);
  params.append('message', text);
  params.append('contactId', String(contactId));
  params.append('contactName', amoUserName || `Пользователь ${amoUserId}`);
  params.append('title', `Обращение из amoMessenger: ${amoUserName || amoUserId}`);

  console.log('📤 Отправляем запрос в Планфикс (webchat/api):');
  console.log('  URL:', CHAT_API_URL);
  console.log('  Параметры:', params.toString());

  try {
    const res = await axios.post(CHAT_API_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    console.log('✅ Сообщение отправлено в Планфикс:', res.status, res.data);
    return res.data;
  } catch (err) {
    if (err.response) {
      console.error('❌ Ошибка при отправке в Планфикс:');
      console.error('  Статус:', err.response.status);
      console.error('  Данные ответа:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('❌ Ошибка:', err.message);
    }
    throw err;
  }
}

// -----------------------------------------------------------
// ДОБАВЛЕНИЕ КОММЕНТАРИЯ (через REST API)
// -----------------------------------------------------------
async function addComment(taskId, text) {
  const body = { description: text };
  const res = await restClient.post(`/task/${taskId}/comments/`, body);
  return res.data;
}

module.exports = {
  findOrCreateContactId,
  findOpenTaskByContactId,
  createTask,
  addComment,
};
