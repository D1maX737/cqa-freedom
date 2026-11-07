import { api } from '../api.js';
import {
  CHANNEL_NAMES, ROLE_NAMES, answerText, answerTone, bindDecisionForms, decisionForm, decisionTriple, errorPanel, fmt, html,
  mountView,
} from './ui.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function fragment(item) {
  const cardLink = (id) => `?view=card&id=${encodeURIComponent(item.conversation_id)}&e=${item.evaluation_id}#${id}`;
  return html`<ol class="fragment" aria-label="Фрагмент диалога">
    ${item.fragment.map((m) => html`<li class="fragment__msg msg--${m.speaker} ${m.anchor ? 'is-anchor' : ''}">
      <a href="${cardLink(m.id)}" data-nav class="fragment__meta">${ROLE_NAMES[m.speaker] ?? m.speaker}, ${m.id}</a>
      <p>${m.text}</p>
    </li>`)}
  </ol>`;
}

function appealItem(item, role) {
  const c = item.criterion;
  const original = c.original?.answer ?? null;
  return html`<article class="appeal-item">
    <header class="appeal-item__head">
      <div>
        <a href="?view=card&id=${encodeURIComponent(item.conversation_id)}&e=${item.evaluation_id}" data-nav class="conv-link">${item.conversation_id}</a>
        <span class="muted">${CHANNEL_NAMES[item.channel] ?? item.channel}, ${item.language}, чек-лист ${item.checklist_version_id}, итог ${fmt(item.total_final)}</span>
      </div>
      <span class="muted">${when(item.created_at)}</span>
    </header>
    <div class="appeal-item__body">
      <div class="appeal-item__case">
        <h3 class="appeal-item__crit"><span class="crit__id">${c.id}</span> ${c.title}
          <span class="answer answer--${answerTone(original, c)}">${answerText(original, c)}</span></h3>
        <p class="crit__why">${c.explanation ?? ''}</p>
        ${c.original?.answer === 'na' && c.na_reason ? html`<p class="na-reason"><span class="links__label">Почему критерий не применяется</span>${c.na_reason}</p>` : ''}
        <p class="appeal__comment appeal__comment--box"><span class="links__label">Комментарий пользователя</span>${item.comment}</p>
        ${item.status === 'decided' ? decisionTriple(c, item) : role === 'reviewer' ? decisionForm(c, item)
          : html`<p class="muted">Решение принимает проверяющий: переключите роль в шапке.</p>`}
      </div>
      ${fragment(item)}
    </div>
  </article>`;
}

export async function render(container, state) {
  const tab = state.appealsTab ?? 'open';
  let items;
  let counts;
  try {
    const [open, decided] = await Promise.all([api.appeals('open'), api.appeals('decided')]);
    counts = { open: open.length, decided: decided.length };
    items = tab === 'open' ? open : decided.reverse();
  } catch (error) {
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }

  const root = mountView(container, html`
    <section class="page-head">
      <h1>Апелляции</h1>
      <div class="seg" role="tablist" aria-label="Статус апелляций">
        <button type="button" role="tab" data-tab="open" aria-selected="${tab === 'open'}">Открытые: ${counts.open}</button>
        <button type="button" role="tab" data-tab="decided" aria-selected="${tab === 'decided'}">Решённые: ${counts.decided}</button>
      </div>
    </section>
    ${items.length === 0
    ? html`<p class="empty">${tab === 'open'
      ? 'Открытых апелляций нет. Пользователь оспаривает критерий кнопкой «Оспорить» в карточке диалога.'
      : 'Решённых апелляций пока нет.'}</p>`
    : html`<div class="appeal-list">${items.map((item) => appealItem(item, state.role))}</div>`}`);

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.appealsTab = button.dataset.tab;
    render(container, state);
  });
  bindDecisionForms(root, api, () => render(container, state));
}
