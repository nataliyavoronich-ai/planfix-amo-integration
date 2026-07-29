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
 
// Ищем среди задач ту, что:
//  - не завершена (isDone = false)
//  - в кастомном поле "amoMessenger ID" стоит нужный ID пользователя
async function findOpenTaskByAmoUserId(amoUserId) {
  const body = {
    offset: 0,
    pageSize: 1,
    filters: [
      {
        type: 51, // фильтр "по значению пользовательского поля"
        field: Number(CUSTOM_FIELD_ID),
        operator: 'equal',
        value: String(amoUserId),
      },
      {
        type: 6, // фильтр "статус / завершённость задачи"
        operator: 'equal',
        value: 'false',
      },
    ],
    fields: 'id,name,status',
  };
 
  const res = await client.post('/task/list', body);
  const tasks = res.data.tasks || [];
  return tasks.length ? tasks[0] : null;
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
  return res.data; // содержит { id: ... }
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
