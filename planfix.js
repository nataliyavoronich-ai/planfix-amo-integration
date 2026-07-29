// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  REST API – для поиска/создания контактов, задач, полей
//  Webchat API – для отправки сообщений с дополнительными данными
//  Хранение amoUserId в поле контакта и в поле задачи
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;
const WEBCHAT_TOKEN = process.env.PLANFIX_WEBCHAT_TOKEN;
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID;
const AMO_TASK_FIELD_ID = process.env.PLANFIX_AMO_TASK_FIELD_ID;
const AMO_CONTACT_FIELD_ID = process.env.PLANFIX_AMO_CONTACT_FIELD_ID; // <-- НОВАЯ ПЕРЕМЕННАЯ
const PROVIDER_ID = 'amomessenger';

const restClient = axios.create({
  baseURL: `https://${ACCOUNT}.${DOMAIN}/rest`,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
});

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
// ПОИСК КОНТАКТА ПО ПОЛЮ "amoMessenger ID"
// -----------------------------------------------------------
async function findContactByAmoUserId(amoUserId) {
  if (!AMO_CONTACT_FIELD_ID) {
    console.warn('⚠️ Не задан PLANFIX_AMO_CONTACT_FIELD_ID, поиск по контакту невозможен');
    return null;
  }
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 4101,                    // пользовательское поле контакта
        field: { id: Number(AMO_CONTACT_FIELD_ID) },
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name,customFields',
  };
  const res = await restClient.post('/contact/list', body);
  console.log('RAW ОТВЕТ при поиске контакта по ID мессенджера:', JSON.stringify(res.data, null, 2));
  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// СОЗДАНИЕ КОНТАКТА С ЗАПОЛНЕНИЕМ ПОЛЯ "amoMessenger ID"
// -----------------------------------------------------------
async function createContact(amoUserId, amoUserName) {
  if (!AMO_CONTACT_FIELD_ID) {
    throw new Error('Не задан PLANFIX_AMO_CONTACT_FIELD_ID');
  }
  const body = {
    template: CONTACT_TEMPLATE_ID ? { id: Number(CONTACT_TEMPLATE_ID) } : undefined,
    name: amoUserName || `amoMessenger ${amoUserId}`,
    customFieldData: [
      {
        field: { id: Number(AMO_CONTACT_FIELD_ID) },
        value: String(amoUserId),
      },
    ],
  };
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  console.log('📤 Создаём контакт с полем amoMessenger ID:', JSON.stringify(body, null, 2));

  try {
    const res = await restClient.post('/contact/', body);
    console.log('✅ Контакт создан, ID:', res.data.id);
    return res.data;
  } catch (err) {
    if (err.response) {
      console.error('❌ Ошибка при создании контакта:');
      console.error('  Статус:', err.response.status);
      console.error('  Данные ответа:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('❌ Ошибка:', err.message);
    }
    throw err;
  }
}

// -----------------------------------------------------------
// НАЙТИ ИЛИ СОЗДАТЬ КОНТАКТ
// -----------------------------------------------------------
async function findOrCreateContactId(amoUserId, amoUserName) {
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  } else {
    console.log(`✅ Контакт найден: ID ${contact.id}, имя "${contact.name}"`);
  }
  return contact.id;
}

// -----------------------------------------------------------
// ПОИСК ОТКРЫТОЙ ЗАДАЧИ ПО amoUserId (через поле задачи)
// -----------------------------------------------------------
async function findTaskByAmoUserId(amoUserId) {
  if (!AMO_TASK_FIELD_ID) {
    console.warn('⚠️ Не задан PLANFIX_AMO_TASK_FIELD_ID');
    return null;
  }
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 4102,
        field: { id: Number(AMO_TASK_FIELD_ID) },
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name,contact,status',
  };
  const res = await restClient.post('/task/list', body);
  console.log('RAW ОТВЕТ при поиске задачи по amoUserId:', JSON.stringify(res.data, null, 2));
  const tasks = res.data.tasks || [];
  if (tasks.length === 0) return null;
  const task = tasks[0];
  if (isClosedStatus(task.status)) {
    console.log(`⚠️ Задача ${task.id} уже завершена`);
    return null;
  }
  return task;
}

// -----------------------------------------------------------
// ПОИСК ОТКРЫТОЙ ЗАДАЧИ ПО КОНТАКТУ
// -----------------------------------------------------------
async function findOpenTaskByContactId(contactId) {
  const body = {
    offset: 0,
    pageSize: 20,
    filters: [
      { type: 7, operator: 'equal', value: `contact:${contactId}` },
    ],
    fields: 'id,name,status',
  };
  const res = await restClient.post('/task/list', body);
  console.log('RAW ОТВЕТ при поиске задач по контакту:', JSON.stringify(res.data, null, 2));
  const tasks = res.data.tasks || [];
  return tasks.find((t) => !isClosedStatus(t.status)) || null;
}

// -----------------------------------------------------------
// ОТПРАВКА СООБЩЕНИЯ В ПЛАНФИКС (Webchat API) с data_amoUserId
// -----------------------------------------------------------
async function createTask({ contactId, amoUserId, amoUserName, text, attachments = [] }) {
  const params = new URLSearchParams();
  params.append('cmd', 'newMessage');
  params.append('providerId', PROVIDER_ID);
  params.append('chatId', String(amoUserId));
  params.append('planfix_token', WEBCHAT_TOKEN);

  let messageText = text || '';
  if (!messageText && attachments && attachments.length > 0) {
    const names = attachments.map(a => a.name || 'file').join(', ');
    messageText = `📎 Вложения: ${names}`;
  }
  params.append('message', messageText || 'Сообщение без текста');
  params.append('contactId', String(contactId));
  params.append('contactName', amoUserName || `Пользователь ${amoUserId}`);
  params.append('title', `Обращение из amoMessenger: ${amoUserName || amoUserId}`);
  params.append('data_amoUserId', String(amoUserId));

  if (attachments && attachments.length > 0) {
    attachments.forEach(file => {
      if (file.name && file.url) {
        params.append('attachments[name]', file.name);
        params.append('attachments[url]', file.url);
      }
    });
  }

  const url = `https://${ACCOUNT}.${DOMAIN}/webchat/api`;
  console.log('📤 Отправляем запрос в Webchat API:', params.toString());

  try {
    const res = await axios.post(url, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('✅ Сообщение отправлено, статус:', res.status);
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка при отправке:', err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------------
// ПОЛУЧЕНИЕ amoUserId ИЗ ЗАДАЧИ
// -----------------------------------------------------------
async function getAmoUserIdFromTask(taskId) {
  try {
    const body = {
      offset: 0,
      pageSize: 1,
      filters: [
        { type: 2, operator: 'equal', value: Number(taskId) },
      ],
      fields: 'id,name,customFields',
    };
    const res = await restClient.post('/task/list', body);
    const task = res.data.tasks?.[0];
    if (!task) return null;
    const field = task.customFields?.find(
      f => f.field?.name === 'amoUserId' || f.field?.id === Number(AMO_TASK_FIELD_ID)
    );
    return field?.value || null;
  } catch (err) {
    console.error('❌ Ошибка при получении задачи:', err.message);
    return null;
  }
}

// -----------------------------------------------------------
// ДОБАВЛЕНИЕ КОММЕНТАРИЯ
// -----------------------------------------------------------
async function addComment(taskId, text) {
  const res = await restClient.post(`/task/${taskId}/comments/`, { description: text });
  return res.data;
}

module.exports = {
  findOrCreateContactId,
  findOpenTaskByContactId,
  createTask,
  addComment,
  getAmoUserIdFromTask,
  findContactByAmoUserId,
};
