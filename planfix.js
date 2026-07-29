// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  REST API – для поиска/создания контактов, задач, полей
//  Webchat API – для отправки сообщений с дополнительными данными
//  Связь через поле задачи amoUserId + контакт по имени (как fallback)
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;
const WEBCHAT_TOKEN = process.env.PLANFIX_WEBCHAT_TOKEN;
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID;
const PROVIDER_ID = 'amomessenger';
const AMO_TASK_FIELD_ID = process.env.PLANFIX_AMO_TASK_FIELD_ID; // ID поля задачи "amoUserId"

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
// ПОИСК ОТКРЫТОЙ ЗАДАЧИ ПО amoUserId (через пользовательское поле)
// -----------------------------------------------------------
async function findTaskByAmoUserId(amoUserId) {
  if (!AMO_TASK_FIELD_ID) {
    console.warn('⚠️ Не задан PLANFIX_AMO_TASK_FIELD_ID, поиск по задаче невозможен');
    return null;
  }
  if (!amoUserId) return null;
  // Проверяем, что значение похоже на UUID (содержит дефисы)
  if (typeof amoUserId === 'string' && !amoUserId.includes('-')) {
    console.warn(`⚠️ Значение "${amoUserId}" не похоже на UUID, возможно передан userName. Игнорируем.`);
    return null;
  }

  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 4102,                       // пользовательское поле задачи
        field: { id: Number(AMO_TASK_FIELD_ID) }, // используем объект field
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name,contact,status',
  };
  console.log('📤 Запрос поиска задачи по amoUserId:', JSON.stringify(body, null, 2));
  const res = await restClient.post('/task/list', body);
  console.log('RAW ОТВЕТ при поиске задачи по amoUserId:', JSON.stringify(res.data, null, 2));
  const tasks = res.data.tasks || [];
  if (tasks.length === 0) return null;
  const task = tasks[0];
  if (isClosedStatus(task.status)) {
    console.log(`⚠️ Задача ${task.id} уже завершена, не используем`);
    return null;
  }
  return task;
}

// -----------------------------------------------------------
// ПОИСК КОНТАКТА ПО ИМЕНИ (fallback)
// -----------------------------------------------------------
async function findContactByName(name) {
  if (!name) return null;
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      { type: 1, operator: 'equal', value: name },
    ],
    fields: 'id,name',
  };
  const res = await restClient.post('/contact/list', body);
  console.log('RAW ОТВЕТ при поиске контакта по имени:', JSON.stringify(res.data, null, 2));
  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// СОЗДАНИЕ НОВОГО КОНТАКТА (только имя)
// -----------------------------------------------------------
async function createContact(amoUserName) {
  const body = {
    template: CONTACT_TEMPLATE_ID ? { id: Number(CONTACT_TEMPLATE_ID) } : undefined,
    name: amoUserName || 'Пользователь amoMessenger',
  };
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  console.log('📤 Создаём контакт (только имя):', JSON.stringify(body, null, 2));

  try {
    const res = await restClient.post('/contact/', body);
    console.log('✅ Контакт создан, ID:', res.data.id);
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка при создании контакта:', err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------------
// НАЙТИ ИЛИ СОЗДАТЬ КОНТАКТ ПО amoUserId
// -----------------------------------------------------------
async function findOrCreateContactId(amoUserId, amoUserName) {
  // 1. Пытаемся найти открытую задачу по amoUserId
  const task = await findTaskByAmoUserId(amoUserId);
  if (task) {
    const contactId = task.contact?.id;
    if (contactId) {
      console.log(`✅ Найдена задача ${task.id} с контактом ${contactId}`);
      return contactId;
    }
    console.warn(`⚠️ В задаче ${task.id} нет контакта, ищем по имени`);
  }

  // 2. Если задача не найдена или в ней нет контакта – ищем по имени
  let contact = await findContactByName(amoUserName);
  if (!contact) {
    contact = await createContact(amoUserName);
  } else {
    console.log(`✅ Контакт найден по имени: ID ${contact.id}, имя "${contact.name}"`);
  }
  return contact.id;
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
  console.log('📤 Отправляем запрос в Планфикс (webchat/api):');
  console.log('  URL:', url);
  console.log('  Параметры:', params.toString());

  try {
    const res = await axios.post(url, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('✅ Сообщение отправлено в Планфикс:', res.status);
    console.log('📦 Полный ответ от Планфикса:', JSON.stringify(res.data, null, 2));
    return res.data;
  } catch (err) {
    console.error('❌ Ошибка при отправке в Планфикс:', err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------------
// ПОЛУЧЕНИЕ amoUserId ИЗ ЗАДАЧИ ПО ЕЁ ID
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
    console.log(`📤 Запрашиваем задачу ${taskId} через POST /task/list`);
    const res = await restClient.post('/task/list', body);
    console.log('🔍 Получена задача:', JSON.stringify(res.data, null, 2));

    const tasks = res.data.tasks || [];
    if (tasks.length === 0) {
      console.warn(`⚠️ Задача ${taskId} не найдена`);
      return null;
    }
    const task = tasks[0];
    const customFields = task.customFields || [];
    const field = customFields.find(f => f.field?.name === 'amoUserId' || f.field?.id === Number(AMO_TASK_FIELD_ID));
    if (field) {
      console.log(`✅ Найдено поле amoUserId: ${field.value}`);
      return field.value;
    }
    console.warn('⚠️ Поле amoUserId не найдено в задаче');
    return null;
  } catch (err) {
    console.error('❌ Ошибка при получении задачи:', err.message);
    if (err.response) {
      console.error('  Статус:', err.response.status);
      console.error('  Данные:', JSON.stringify(err.response.data, null, 2));
    }
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
};
