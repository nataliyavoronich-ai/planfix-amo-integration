// ============================================================
//  МОДУЛЬ РАБОТЫ С ПЛАНФИКС
//  Использует официальный REST API Планфикс:
//  https://help.planfix.com/restapidocs/
// ============================================================

const axios = require('axios');

const ACCOUNT = process.env.PLANFIX_ACCOUNT;      // например "zlmktest"
const DOMAIN = process.env.PLANFIX_DOMAIN || 'planfix.com'; // planfix.com или planfix.ru
const TOKEN = process.env.PLANFIX_TOKEN;          // токен из Управление аккаунтом -> Доступ к API
const CUSTOM_FIELD_ID = process.env.PLANFIX_AMO_FIELD_ID; // ID пользовательского поля "amoMessenger ID"
const PROJECT_ID = process.env.PLANFIX_PROJECT_ID; // ID проекта, в который создавать задачи (необязательно)

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

// Ищем среди задач ту, что:
//  - в кастомном поле "amoMessenger ID" стоит нужный ID пользователя
//  - ещё не завершена (проверяем по названию статуса, см. isClosedStatus)
async function findOpenTaskByAmoUserId(amoUserId) {
  const body = {
    offset: 0,
    pageSize: 20,
    filters: [
      {
        type: 101, // Пользовательское поле типа "Строка"
        field: Number(CUSTOM_FIELD_ID),
        operator: 'equal',
        value: String(amoUserId),
      },
    ],
    fields: 'id,name,status',
  };

  const res = await client.post('/task/list', body);

  // ВРЕМЕННО (для отладки): смотрим, что реально нашёл Планфикс
  console.log('RAW ОТВЕТ Планфикс при поиске открытой задачи:', JSON.stringify(res.data, null, 2));

  const tasks = res.data.tasks || [];
  const openTask = tasks.find((t) => !isClosedStatus(t.status));
  return openTask || null;
}

// Создаём новую задачу
async function createTask({ amoUserId, amoUserName, text }) {
  const body = {
    name: `Обращение из amoMessenger: ${amoUserName || amoUserId}`,
    description: text,
    project: PROJECT_ID ? { id: Number(PROJECT_ID) } : undefined,
    customFieldData: [
      {
        field: { id: Number(CUSTOM_FIELD_ID) },
        value: String(amoUserId),
      },
    ],
  };

  const res = await client.post('/task/', body);

  // ВРЕМЕННО (для отладки): смотрим, что реально вернул Планфикс
  console.log('RAW ОТВЕТ Планфикс при создании задачи:', JSON.stringify(res.data, null, 2));

  return res.data;
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
  findOpenTaskByAmoUserId,
  createTask,
  addComment,
};
