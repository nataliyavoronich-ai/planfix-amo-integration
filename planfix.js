// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  Использует официальный REST API Планфикс:
//  https://help.planfix.com/restapidocs/
//
//  НОВАЯ ЛОГИКА:
//  amoMessenger ID хранится в пользовательском поле НА КОНТАКТЕ
//  (а не на задаче, как было раньше — там мы упёрлись в
//  ограничение доступа поля по процессу/шаблону задачи).
//  Дальше задача связывается с этим контактом через стандартное,
//  встроенное поле "Контрагент" — оно не кастомное и не требует
//  отдельных разрешений.
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;      // например "zlmktest"
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com'; // planfix.com или planfix.ru
const TOKEN = process.env.PLANFIX_TOKEN;          // токен из Управление аккаунтом -> Доступ к API
const CONTACT_FIELD_ID = process.env.PLANFIX_AMO_CONTACT_FIELD_ID; // ID поля "amoMessenger ID" НА КОНТАКТЕ
const CONTACT_TEMPLATE_ID = process.env.PLANFIX_CONTACT_TEMPLATE_ID; // ID шаблона, по которому создаётся контакт
const PROJECT_ID = process.env.PLANFIX_PROJECT_ID; // ID проекта, в который создавать задачи (необязательно)

// ⚠️ ВАШ ID В ПЛАНФИКСЕ (указан как 1) – задача будет назначена на вас
const RESPONSIBLE_ID = 1; // если ваш ID другой – замените

const BASE_URL = `https://${ACCOUNT}.${DOMAIN}/rest`;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
});

// Названия статусов, которые считаем "задача завершена".
// Если в вашем Планфиксе статусы называются иначе — допишите
// нужные слова через переменную окружения PLANFIX_CLOSED_STATUS_WORDS
// (через запятую), иначе используются слова по умолчанию.
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
// Ищем контакт в Планфикс по значению поля "amoMessenger ID"
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
    template: { id: Number(CONTACT_TEMPLATE_ID) },
    name: amoUserName || `amoMessenger ${amoUserId}`,
    customFieldData: [
      {
        field: { id: Number(CONTACT_FIELD_ID) },
        value: String(amoUserId),
      },
    ],
  };

  const res = await client.post('/contact/', body);

  console.log('RAW ОТВЕТ Планфикс при создании контакта:', JSON.stringify(res.data, null, 2));

  return res.data;
}

// Находит контакт по amoUserId, а если его ещё нет — создаёт.
// Возвращает числовой ID контакта в Планфикс.
async function findOrCreateContactId(amoUserId, amoUserName) {
  let contact = await findContactByAmoUserId(amoUserId);
  if (!contact) {
    contact = await createContact(amoUserId, amoUserName);
  }
  return contact.id;
}

// -----------------------------------------------------------
// Ищем среди задач ту, где данный контакт указан как
// контрагент (Контрагент — встроенное поле, тип фильтра 7)
// и задача ещё не завершена.
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
// Создаём новую задачу, привязанную к контакту как контрагенту
// -----------------------------------------------------------
async function createTask({ contactId, amoUserId, amoUserName, text }) {
  const body = {
    name: `Обращение из amoMessenger: ${amoUserName || amoUserId}`,
    description: text,
    project: PROJECT_ID ? { id: Number(PROJECT_ID) } : undefined,
    contact: { id: contactId },
    responsible: { id: RESPONSIBLE_ID }, // <-- добавлено обязательное поле
  };

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

// Добавляем комментарий к существующей задаче
async function addComment(taskId, text) {
  const body = {
    description: text,
  };
  const res = await client.post(`/task/${taskId}/comments/`, body);
  return res.data;
}

module.exports = {
  findOrCreateContactId,
  findOpenTaskByContactId,
  createTask,
  addComment,
};
