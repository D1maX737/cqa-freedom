// Единственная точка доступа к бэкенду. В Dynamics 365 адрес задаётся через window.CQA_CONFIG.apiBase.
const BASE = (globalThis.CQA_CONFIG?.apiBase ?? 'api').replace(/\/$/, '');

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error ?? `Сервер ответил ${response.status}`);
    error.details = data?.errors ?? [];
    throw error;
  }
  return data;
}

const query = (params) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return search.size ? `?${search}` : '';
};

export const api = {
  health: () => request('GET', '/health'),
  groups: () => request('GET', '/groups'),
  fetchDataset: (group) => request('POST', `/datasets/${encodeURIComponent(group)}/fetch`),
  importConversations: (json, group) => request('POST', `/conversations/import${query({ group })}`, json),
  conversations: (filters = {}) => request('GET', `/conversations${query(filters)}`),
  conversation: (id) => request('GET', `/conversations/${encodeURIComponent(id)}`),
  audioUrl: (id) => `${BASE}/conversations/${encodeURIComponent(id)}/audio`,
  checklists: () => request('GET', '/checklists'),
  checklist: (id) => request('GET', `/checklists/${encodeURIComponent(id)}`),
  createChecklist: (name, config) => request('POST', '/checklists', { name, config }),
  evaluate: (conversationIds, checklistVersionId) => request('POST', '/evaluations', { conversation_ids: conversationIds, checklist_version_id: checklistVersionId }),
  evaluation: (id) => request('GET', `/evaluations/${encodeURIComponent(id)}`),
  createAppeal: (evaluationId, criterionId, comment) => request('POST', '/appeals', { evaluation_id: evaluationId, criterion_id: criterionId, comment }),
  appeals: (status) => request('GET', `/appeals${query({ status })}`),
  decide: (appealId, decision) => request('POST', `/appeals/${encodeURIComponent(appealId)}/decision`, decision),
  labels: () => request('GET', '/labels'),
  saveLabel: (conversationId, label) => request('PUT', `/labels/${encodeURIComponent(conversationId)}`, label),
  accuracy: (params) => request('GET', `/accuracy${query(params)}`),
};
