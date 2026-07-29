// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  Использует официальный REST API Планфикс:
//  https://help.planfix.com/restapidocs/
//
//  НОВАЯ ЛОГИКА:
//  amoMessenger ID хранится в пользовательском поле НА КОНТАКТЕ
//  Дальше задача связывается с этим контактом через стандартное
//  поле "Контрагент" (передаётся как id контакта).
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;                // например "zlmktest"
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';  // planfix.com или planfix.ru
const TOKEN = process.env.PLANFIX_TOKEN;                    // токен API
const CONTACT_FIELD_ID = process.env.PLANFIX_AMO_CONTACT_FIELD_ID; // ID поля "amoMessenger ID" НА КОНТАКТЕ
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID; // ID шаблона для создания контакта (необязательно)
const PROJECT_ID = process.env.PLANFIX_PROJECT_ID;          // ID проекта для задач (необязательно)
const RESPONSIBLE_ID = 1;                                   // ВАШ ID в Планфиксе (замените, если другой)

const BASE_URL = `https://${ACCOUNT}.${DOMAIN}/rest`;

const client = axios.create({
  baseURL: BASE_URL,
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
// Ищем контакт по amoMessenger ID (пользовательское поле)
// -----------------------------------------------------------
async function findContactByAmoUserId(amoUserId) {
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 4101, // Пользовательское поле контакта типа "Строка"
        field: Number(CONTACT_FIELD_ID),
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name',
  };

  const res = await client.post('/contact/list', body);
  console.log('RAW ОТВЕТ Планфикс при поиске контакта:', JSON.stringify(res.data, null, 2));

  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// Создаём новый контакт с привязкой к amoMessenger ID
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
  // Убираем undefined поля
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  const res = await client.post('/contact/', body);
  console.log('RAW ОТВЕТ Планфикс при создании контакта:', JSON.stringify(res.data, null, 2));
  return res.data;
}

// Находит контакт по amoUserId, если нет – создаёт.
async function findOrCreateContactId(amoUserId, amoUserName) {
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  }
  return contact.id;
}

// -----------------------------------------------------------
// Ищем открытую задачу, где контакт указан как "Контрагент"
// -----------------------------------------------------------
async function findOpenTaskByContactId(contactId) {
  const body = {
    offset: 0,
    pageSize: 20,
    filters: [
      {
        type: 7, // Контрагент
        operator: 'equal',
        value: `contact:${contactId}`,
      },
    ],
    fields: 'id,name,status',
  };

  const res = await client.post('/task/list', body);
  console.log('RAW ОТВЕТ Планфикс при поиске открытой задачи:', JSON.stringify(res.data, null, 2));

  const tasks = res.data.tasks || [];
  const openTask = tasks.find((t) => !isClosedStatus(t.status));
  return openTask || null;
}

// -----------------------------------------------------------
// Создаём задачу, привязанную к контакту
// -----------------------------------------------------------
async function createTask({ contactId, amoUserId, amoUserName, text }) {
  const body = {
    name: `Обращение из amoMessenger: ${amoUserName || amoUserId}`,
    description: text,
    project: PROJECT_ID ? Number(PROJECT_ID) : undefined,    // просто число
    contact: contactId,                                     // просто число
    responsible: RESPONSIBLE_ID,                           // просто число
  };

  // Убираем поля, которые не заданы
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  try {
    const res = await client.post('/task/', body);
    console.log('✅ Задача создана:', JSON.stringify(res.data, null, 2));
    return res.data;
  } catch (err) {
    if (err.response) {
      console.error('❌ Ошибка при создании задачи:');
      console.error('  Статус:', err.response.status);
      console.error('  Данные ответа:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('❌ Ошибка:', err.message);
    }
    throw err;
  }
}

// -----------------------------------------------------------
// Добавляем комментарий к задаче
// -----------------------------------------------------------
async function addComment(taskId, text) {
  const body = { description: text };
  const res = await client.post(`/task/${taskId}/comments/`, body);
  return res.data;
}

module.exports = {
  findOrCreateContactId,
  findOpenTaskByContactId,
  createTask,
  addComment,
};
