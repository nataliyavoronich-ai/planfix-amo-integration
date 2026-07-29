// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  REST API – для поиска/создания контактов, задач, полей
//  Webchat API – для отправки сообщений с дополнительными данными
//  Хранение amoUserId в поле code (внешний код) контакта
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;
const WEBCHAT_TOKEN = process.env.PLANFIX_WEBCHAT_TOKEN;
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID;
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
// ПОИСК КОНТАКТА ПО ВНЕШНЕМУ КОДУ (type=1005)
// -----------------------------------------------------------
async function findContactByAmoUserId(amoUserId) {
  if (!amoUserId) return null;
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 1005,               // внешний код контакта
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name,code',
  };
  const res = await restClient.post('/contact/list', body);
  console.log('RAW ОТВЕТ при поиске контакта по коду:', JSON.stringify(res.data, null, 2));
  const contacts = res.data.contacts || [];
  return contacts.length ? contacts[0] : null;
}

// -----------------------------------------------------------
// СОЗДАНИЕ НОВОГО КОНТАКТА С ВНЕШНИМ КОДОМ
// -----------------------------------------------------------
async function createContact(amoUserId, amoUserName) {
  const body = {
    template: CONTACT_TEMPLATE_ID ? { id: Number(CONTACT_TEMPLATE_ID) } : undefined,
    name: amoUserName || `Пользователь ${amoUserId}`,
    code: String(amoUserId),   // сохраняем внешний код
  };
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  console.log('📤 Создаём контакт с кодом:', JSON.stringify(body, null, 2));

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
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  } else {
    console.log(`✅ Контакт найден: ID ${contact.id}, имя "${contact.name}"`);
    // Если имя изменилось – обновим
    if (amoUserName && contact.name !== amoUserName) {
      await updateContactName(contact.id, amoUserName);
    }
  }
  return contact.id;
}

// -----------------------------------------------------------
// ОБНОВЛЕНИЕ ИМЕНИ КОНТАКТА (если изменилось)
// -----------------------------------------------------------
async function updateContactName(contactId, newName) {
  const body = { id: contactId, name: newName };
  console.log(`🔄 Обновляем имя контакта ${contactId} на "${newName}"`);
  const res = await restClient.post('/contact/', body);
  console.log('RAW ОТВЕТ при обновлении имени:', JSON.stringify(res.data, null, 2));
  return res.data;
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
};
