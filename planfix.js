// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;
const CONTACT_FIELD_ID = process.env.PLANFIX_AMO_CONTACT_FIELD_ID;
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID;
// Временно игнорируем PROJECT_ID – будем создавать задачи без проекта
// const PROJECT_ID = process.env.PLANFIX_PROJECT_ID;
const RESPONSIBLE_ID = 1; // ваш ID

const BASE_URL = `https://${ACCOUNT}.${DOMAIN}/rest`;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
});

// Статусы завершённых задач
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
// Поиск контакта по amoMessenger ID
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
  const res = await client.post('/contact/list', body);
  console.log('RAW ОТВЕТ Планфикс при поиске контакта:', JSON.stringify(res.data, null, 2));
  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// Создание контакта
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
  const res = await client.post('/contact/', body);
  console.log('RAW ОТВЕТ Планфикс при создании контакта:', JSON.stringify(res.data, null, 2));
  return res.data;
}

async function findOrCreateContactId(amoUserId, amoUserName) {
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  }
  return contact.id;
}

// -----------------------------------------------------------
// Поиск открытой задачи по контакту
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
  const res = await client.post('/task/list', body);
  console.log('RAW ОТВЕТ Планфикс при поиске открытой задачи:', JSON.stringify(res.data, null, 2));
  const tasks = res.data.tasks || [];
  const openTask = tasks.find((t) => !isClosedStatus(t.status));
  return openTask || null;
}

// -----------------------------------------------------------
// СОЗДАНИЕ ЗАДАЧИ (исправленная версия)
// -----------------------------------------------------------
async function createTask({ contactId, amoUserId, amoUserName, text }) {
  // Формируем тело с объектами { id: ... } для связей
  const body = {
    name: `Обращение из amoMessenger: ${amoUserName || amoUserId}`,
    description: text,
    contact: { id: contactId },
    responsible: { id: RESPONSIBLE_ID },
    // project: { id: Number(PROJECT_ID) }  // пока убираем, чтобы проверить
  };

  // Удаляем undefined поля (если есть)
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  console.log('📤 Отправляем запрос на создание задачи:', JSON.stringify(body, null, 2));

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

// Добавление комментария
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
