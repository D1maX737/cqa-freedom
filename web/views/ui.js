const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class Html {
  constructor(text) { this.text = text; }

  toString() { return this.text; }
}

const part = (value) => {
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
};

/** Шаблон с экранированием всех подстановок: текст диалогов приходит от клиентов и модели. */
export const html = (strings, ...values) => new Html(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''));

/** Каждый рендер получает новый корень, чтобы обработчики не копились. */
export function mountView(container, template) {
  const root = document.createElement('div');
  root.className = 'cqa-view';
  root.innerHTML = String(template);
  container.replaceChildren(root);
  return root;
}

export const ROLE_NAMES = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
export const CHANNEL_NAMES = { 'agent chat': 'Чат', 'voice call': 'Звонок' };
export const STATUS_NAMES = { queued: 'в очереди', running: 'оценивается', done: 'готово', failed: 'ошибка' };

export const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }));

export function clock(sec) {
  if (sec === null || sec === undefined) return '';
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function answerText(answer, criterion) {
  if (answer === null || answer === undefined) return 'Не оценено';
  if (answer === 'na') return 'Не применяется';
  if (criterion.type === 'scale') return `${answer} из ${Math.max(...criterion.scale)}`;
  if (criterion.type === 'flag') return answer === 'yes' ? 'Есть' : 'Нет';
  return answer === 'yes' ? 'Да' : 'Нет';
}

export function answerTone(answer, criterion) {
  if (answer === null || answer === undefined) return 'none';
  if (answer === 'na') return 'na';
  if (criterion.type === 'flag') return answer === 'yes' ? 'bad' : 'good';
  if (criterion.type === 'scale') {
    const value = Number(answer);
    if (value === Math.max(...criterion.scale)) return 'good';
    return value === 0 ? 'bad' : 'partial';
  }
  return answer === 'yes' ? 'good' : 'bad';
}

export function toast(message, tone = 'info') {
  const host = document.querySelector('.cqa') ?? document.body;
  const node = document.createElement('div');
  node.className = `toast toast--${tone}`;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), tone === 'error' ? 7000 : 3500);
}

export function errorPanel(error, retryLabel = 'Повторить') {
  return html`<div class="panel panel--error" role="alert">
    <p>${error.message}</p>
    ${error.details?.length ? html`<ul>${error.details.map((d) => html`<li>${d}</li>`)}</ul>` : ''}
    <button type="button" class="btn" data-action="retry">${retryLabel}</button>
  </div>`;
}

/** Форма решения проверяющего: общая для карточки и очереди апелляций. */
export function decisionForm(criterion, appeal) {
  return html`<form class="decision" data-appeal="${appeal.id}">
    <fieldset class="decision__choice">
      <legend>Решение по апелляции</legend>
      <label><input type="radio" name="action" value="confirm" checked> Подтвердить оценку</label>
      <label><input type="radio" name="action" value="change"> Изменить на
        <select name="new_value" aria-label="Новое значение">
          ${criterion.decision_values.map((v) => html`<option value="${v}">${answerText(v, criterion)}</option>`)}
        </select>
      </label>
    </fieldset>
    <label class="field">Причина решения
      <textarea name="reason" rows="2" required placeholder="Например: в реплике m3 оператор представился"></textarea>
    </label>
    <button type="submit" class="btn btn--primary">Сохранить решение</button>
  </form>`;
}

export function bindDecisionForms(root, api, onDone) {
  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('form.decision');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api.decide(form.dataset.appeal, {
        action: data.get('action'),
        new_value: data.get('action') === 'change' ? data.get('new_value') : undefined,
        reason: data.get('reason'),
      });
      toast('Решение сохранено, итог пересчитан');
      onDone();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  });
}

/** Три колонки «исходная — решение — финальная» для решённой апелляции. */
export function decisionTriple(criterion, appeal) {
  const decision = appeal.action === 'change' ? `Изменить на «${answerText(appeal.new_value, criterion)}»` : 'Подтвердить';
  return html`<div class="triple">
    <div><span class="triple__label">Исходная</span><strong>${answerText(criterion.original?.answer, criterion)}</strong>
      <span class="triple__pts">${fmt(criterion.original?.score)} балл.</span></div>
    <div><span class="triple__label">Решение</span><strong>${decision}</strong><span class="triple__pts">${appeal.reason}</span></div>
    <div><span class="triple__label">Финальная</span><strong>${answerText(criterion.final?.answer, criterion)}</strong>
      <span class="triple__pts">${fmt(criterion.final?.score)} балл.</span></div>
  </div>`;
}
