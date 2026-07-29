// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  Поиск контакта по имени, получение задачи по ID
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;
const WEBCHAT_TOKEN = process.env.PLANFIX_WEBCHAT_TOKEN;
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
// ПОИСК КОНТАКТА ПО ИМЕНИ
// -----------------------------------------------------------
async function findContactByName(name) {
  if (!name) return null;
  const cleanName = name.trim();
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      { type: 1, operator: 'equal', value: cleanName },
    ],
    fields: 'id,name',
  };
  console.log('📤 Поиск контакта по имени:', cleanName);
  const res = await restClient.post('/contact/list', body);
  console.log('RAW ОТВЕТ при поиске по имени:', JSON.stringify(res.data, null, 2));
  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// СОЗДАНИЕ КОНТАКТА (без шаблона, только имя)
// -----------------------------------------------------------
async function createContact(amoUserName) {
  const cleanName = (amoUserName || 'Пользователь amoMessenger').trim();
  const body = { name: cleanName };

  console.log('📤 Создаём контакт:', JSON.stringify(body, null, 2));

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
// НАЙТИ ИЛИ СОЗДАТЬ КОНТАКТ ПО ИМЕНИ
// -----------------------------------------------------------
async function findOrCreateContactId(amoUserName) {
  const cleanName = (amoUserName || '').trim();
  if (!cleanName) {
    throw new Error('Имя пользователя не может быть пустым');
  }
  let contact = await findContactByName(cleanName);
  if (!contact) {
    contact = await createContact(cleanName);
  } else {
    console.log(`✅ Контакт найден: ID ${contact.id}, имя "${contact.name}"`);
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
// ОТПРАВКА СООБЩЕНИЯ В ПЛАНФИКС (Webchat API)
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
// ПОЛУЧЕНИЕ amoUserId ИЗ ЗАДАЧИ ПО ID
// -----------------------------------------------------------
async function getAmoUserIdFromTask(taskId) {
  try {
    // Используем GET /task/get с параметром id
    const res = await restClient.get('/task/get', {
      params: {
        id: Number(taskId),
        fields: 'id,name,customFields'
      }
    });
    console.log('🔍 Получена задача:', JSON.stringify(res.data, null, 2));
    const task = res.data.task || res.data;
    const customFields = task.customFields || [];
    const field = customFields.find(f => f.field?.name === 'amoUserId');
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
