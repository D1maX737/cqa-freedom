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

export function render(container) {
  mountView(container, html`
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
}
