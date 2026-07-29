// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  REST API – для поиска/создания/обновления контактов и задач
//  Webchat API – для отправки сообщений
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com';
const TOKEN = process.env.PLANFIX_TOKEN;                     // REST токен
const WEBCHAT_TOKEN = process.env.PLANFIX_WEBCHAT_TOKEN;      // Ключ провайдера веб-чата
const CONTACT_FIELD_ID = process.env.PLANFIX_AMO_CONTACT_FIELD_ID;
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID;
const PROVIDER_ID = 'amomessenger';

// REST клиент
const restClient = axios.create({
  baseURL: `https://${ACCOUNT}.${DOMAIN}/rest`,
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
// ПОИСК КОНТАКТА по amoMessenger ID
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
// СОЗДАНИЕ НОВОГО КОНТАКТА (с проверкой поля)
// -----------------------------------------------------------
async function createContact(amoUserId, amoUserName) {
  const body = {
    template: CONTACT_TEMPLATE_ID ? { id: Number(CONTACT_TEMPLATE_ID) } : undefined,
    name: amoUserName || `amoMessenger ${amoUserId}`,
    customFieldData: [
      {
        field: { id: Number(CONTACT_FIELD_ID) },   // правильный формат
        value: String(amoUserId),
      },
    ],
  };
  Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);

  console.log('📤 Отправляем запрос на создание контакта:', JSON.stringify(body, null, 2));

  try {
    const res = await restClient.post('/contact/', body);
    console.log('✅ Контакт создан, ID:', res.data.id);

    // Проверяем, заполнилось ли поле
    const checkRes = await restClient.get(`/contact/${res.data.id}?fields=id,name,customFields`);
    console.log('🔍 ПРОВЕРКА КОНТАКТА ПОСЛЕ СОЗДАНИЯ:');
    console.log(JSON.stringify(checkRes.data, null, 2));

    // Ищем в ответе наше поле
    const customFields = checkRes.data.customFields || [];
    const found = customFields.find(f => f.field?.id === Number(CONTACT_FIELD_ID));
    if (found) {
      console.log(`✅ Поле amoMessenger ID заполнено: ${found.value}`);
    } else {
      console.warn(`⚠️ Поле с ID ${CONTACT_FIELD_ID} не найдено в контакте. Возможно, ID поля неверен.`);
    }

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
// ОБНОВЛЕНИЕ ИМЕНИ КОНТАКТА (если изменилось)
// -----------------------------------------------------------
async function updateContactName(contactId, newName) {
  const body = {
    id: contactId,
    name: newName,
  };
  console.log(`🔄 Обновляем имя контакта ${contactId} на "${newName}"`);
  const res = await restClient.post('/contact/', body);
  console.log('RAW ОТВЕТ Планфикс при обновлении контакта:', JSON.stringify(res.data, null, 2));
  return res.data;
}

// -----------------------------------------------------------
// НАЙТИ ИЛИ СОЗДАТЬ КОНТАКТ, ПРИ НЕОБХОДИМОСТИ ОБНОВИТЬ ИМЯ
// -----------------------------------------------------------
async function findOrCreateContactId(amoUserId, amoUserName) {
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  } else if (amoUserName && contact.name !== amoUserName) {
    await updateContactName(contact.id, amoUserName);
    contact.name = amoUserName;
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
// ДОБАВЛЕНИЕ КОММЕНТАРИЯ
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
