import { api } from '../api.js';
import { html, mountView } from './ui.js';

const icon = (path) => html`<svg viewBox="0 0 24 24" width="24" height="24" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="${path}"/>
</svg>`;

const arrow = icon('M4 12h15m-6-6 6 6-6 6');
const features = [
  {
    view: 'list',
    icon: icon('M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2ZM8 9h8m-8 4h5'),
    title: 'Анализ диалогов',
    description: 'Оцените чаты и звонки. Откройте транскрипт и проверьте реплики, на которых основаны баллы.',
    action: 'Открыть диалоги',
  },
  {
    view: 'appeals',
    icon: icon('M12 3 4 6v5c0 4.4 3.1 8.1 8 10 4.9-1.9 8-5.6 8-10V6Zm-3 9 2 2 4-4'),
    title: 'Разбор апелляций',
    description: 'Оспорьте оценку по критерию. После решения проверяющего итоговый балл пересчитается.',
    action: 'К апелляциям',
  },
  {
    view: 'checklists',
    icon: icon('M9 5h6m-7 0H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 4h8v3H8Zm0 8 1.5 1.5L12 11m2 2h3m-9 4h9'),
    title: 'Настройка чек-листов',
    description: 'Меняйте критерии, веса и подсказки для модели. Применяйте новую версию к выбранным диалогам.',
    action: 'К чек-листам',
  },
];

const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const LANGUAGE_NAMES = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
const cardLink = (id) => html`<a href="?view=card&id=${encodeURIComponent(id)}" data-nav>${id}</a>`;

function summary(o) {
  if (!o.dialogs) {
    return html`<div class="empty"><p>Оценок моделью пока нет${o.mock_skipped ? ': оценки в тестовом режиме в сводку не входят' : ''}.
      <a href="?view=list" data-nav>Загрузите набор и оцените диалоги</a>, и здесь появится сводка.</p></div>`;
  }
  const maxLoss = Math.max(...o.losses.map((l) => l.average_lost), 0.01);
  const maxBucket = Math.max(...o.distribution.map((b) => b.count), 1);
  return html`
    <dl class="overview__stats">
      <div><dt>Средний балл</dt><dd>${num(o.average)}</dd><p>из 100</p></div>
      <div><dt>Без замечаний</dt><dd>${o.perfect}</dd><p>${plural(o.perfect, 'диалог', 'диалога', 'диалогов')} на 100 баллов</p></div>
      <div><dt>Ниже 70 баллов</dt><dd>${o.below70}</dd><p>${plural(o.below70, 'диалог', 'диалога', 'диалогов')}</p></div>
      <div><dt>Грубые ошибки</dt><dd>${o.gross.length}</dd><p>учитываются отдельно от балла</p></div>
      <div><dt>Открытые апелляции</dt><dd>${o.open_appeals}</dd><p><a href="?view=appeals" data-nav>к очереди</a></p></div>
    </dl>
    <div class="overview__grid">
      <section class="overview__block" aria-labelledby="losses-title">
        <h3 id="losses-title">Где операторы теряют баллы</h3>
        <p class="overview__hint">Сколько баллов из 100 критерий отнимает в среднем на диалог, с учётом веса.</p>
        <ol class="losses">
          ${o.losses.map((l) => html`<li class="loss" title="${l.id}: в среднем −${num(l.average_lost)} балла, не выполнен полностью в ${l.failed} из ${l.applicable}">
            <div class="loss__head"><span>${l.id} ${l.title}</span><strong>−${num(l.average_lost)}</strong></div>
            <div class="loss__track" aria-hidden="true"><span style="width:${(l.average_lost / maxLoss) * 100}%"></span></div>
            <p class="loss__meta">Не выполнен полностью в ${l.failed} из ${l.applicable}.
              ${l.example ? html`Например, ${cardLink(l.example.conversation_id)}${l.example.text ? html`: «${l.example.text.length > 110 ? `${l.example.text.slice(0, 110)}…` : l.example.text}»` : ''}` : ''}</p>
          </li>`)}
        </ol>
      </section>
      <div class="overview__side">
        <section class="overview__block" aria-labelledby="gross-title">
          <h3 id="gross-title">Грубые ошибки</h3>
          ${o.gross.length ? html`<ul class="overview__list">${o.gross.map((g) => html`<li>${cardLink(g.conversation_id)}${g.explanation ? html` — ${g.explanation}` : ''}</li>`)}</ul>`
            : html`<p class="overview__hint">Не найдено.</p>`}
        </section>
        <section class="overview__block" aria-labelledby="dist-title">
          <h3 id="dist-title">Распределение итогов</h3>
          <ul class="buckets">${o.distribution.map((b) => html`<li title="${b.label}: ${b.count}">
            <span class="buckets__label">${b.label}</span>
            <span class="buckets__track" aria-hidden="true"><span style="width:${(b.count / maxBucket) * 100}%"></span></span>
            <span class="buckets__count">${b.count}</span>
          </li>`)}</ul>
        </section>
        <section class="overview__block" aria-labelledby="lang-title">
          <h3 id="lang-title">По языкам</h3>
          <div class="overview__scroll"><table class="grid overview__table">
            <thead><tr><th>Язык</th><th class="num">Диалогов</th><th class="num">Средний балл</th><th class="num">Грубых</th></tr></thead>
            <tbody>${o.by_language.map((l) => html`<tr><td>${LANGUAGE_NAMES[l.language] ?? l.language}</td><td class="num">${l.dialogs}</td>
              <td class="num">${num(l.average)}</td><td class="num">${l.gross}</td></tr>`)}</tbody>
          </table></div>
        </section>
        <section class="overview__block" aria-labelledby="worst-title">
          <h3 id="worst-title">Самые низкие баллы</h3>
          <ol class="overview__list">${o.worst.map((w) => html`<li>${cardLink(w.conversation_id)} — ${num(w.total)}${w.gross ? ', грубая ошибка' : ''}</li>`)}</ol>
        </section>
      </div>
    </div>`;
}

async function loadSummary(root, state, route) {
  const target = root.querySelector('[data-overview]');
  try {
    const groups = await api.groups();
    const group = (groups.find((g) => g.group_id === 'DEV') ?? groups[0])?.group_id;
    const overview = await api.overview({ group });
    if (route !== state.route) return;
    target.querySelector('[data-overview-head]').textContent = group ? `Сводка по набору ${group}` : 'Сводка';
    target.querySelector('[data-overview-meta]').textContent = overview.dialogs
      ? `Оценено ${overview.dialogs} из ${overview.conversations} диалогов, модель ${overview.models.join(', ')}, чек-лист ${overview.checklist_version_id}. Решения проверяющих учтены.`
      : '';
    target.querySelector('[data-overview-body]').innerHTML = String(summary(overview));
  } catch (error) {
    if (route !== state.route) return;
    target.querySelector('[data-overview-body]').innerHTML = String(html`<p class="overview__hint">Сводка не загрузилась: ${error.message}</p>`);
  } finally {
    target.removeAttribute('aria-busy');
  }
}

export function render(container, state) {
  const route = state?.route;
  const root = mountView(container, html`
    <section class="hero" aria-labelledby="overview-title">
      <div class="hero__copy">
        <p class="hero__tag"><span aria-hidden="true"></span> Conversation Quality Analytics</p>
        <h1 id="overview-title">Качество диалогов <span>под контролем</span></h1>
        <p class="hero__description">Оценивайте чаты и звонки по чек-листу. Проверяйте обоснования и переходите от цитат к исходным репликам.</p>
        <a class="btn btn--primary hero__cta" href="?view=list" data-nav>Начать ${arrow}</a>
        <p class="hero__meta">Чаты и звонки <span>RU</span><span>KZ</span><span>EN</span></p>
      </div>
      <div class="hero__visual">
        <figure class="hero-demo">
          <figcaption class="hero-demo__head">
            <span>${icon('M3 12h4l3-6 4 12 3-6h4')} Пример оценки</span>
            <span class="hero-demo__channel">Чат · RU</span>
          </figcaption>
          <div class="hero-demo__score">
            <div>
              <p>Итоговый балл</p>
              <strong>92<span> / 100</span></strong>
            </div>
            <div class="hero-demo__ring" aria-hidden="true">${icon('m7 12 3 3 7-7')}</div>
          </div>
          <div class="hero-demo__proof">
            <p class="hero-demo__label">Цитата из диалога</p>
            <blockquote>«Я проверю статус заявки и подскажу, что делать дальше»</blockquote>
            <p class="hero-demo__ref">Оператор <span>00:24</span></p>
          </div>
        </figure>
      </div>
    </section>

    <section class="features" aria-labelledby="features-title">
      <p class="features__label">Рабочее пространство</p>
      <h2 id="features-title">От диалога до решения</h2>
      <div class="features__grid">
        ${features.map((feature) => html`
          <a class="feature" href="?view=${feature.view}" data-nav>
            <span class="feature__icon">${feature.icon}</span>
            <h3>${feature.title}</h3>
            <p>${feature.description}</p>
            <span class="feature__action">${feature.action} ${arrow}</span>
          </a>`)}
      </div>
    </section>`);
  // Сводка встаёт между первым экраном и разделами, когда придут данные.
  root.querySelector('.features').insertAdjacentHTML('beforebegin', String(html`<section class="overview" data-overview aria-busy="true" aria-labelledby="overview-summary-title">
    <header class="overview__head">
      <h2 id="overview-summary-title" data-overview-head>Сводка</h2>
      <p data-overview-meta></p>
    </header>
    <div data-overview-body><p class="overview__hint">Загрузка…</p></div>
  </section>`));
  if (state) loadSummary(root, state, route);
}
