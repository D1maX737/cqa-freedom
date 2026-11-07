import { api } from './api.js';
import { html } from './views/ui.js';
import * as home from './views/home.js';
import * as list from './views/list.js';
import * as card from './views/card.js';
import * as appeals from './views/appeals.js';
import * as checklists from './views/checklist-editor.js';

const VIEWS = { home, list, card, appeals, checklists };
const NAV = [['home', 'Обзор'], ['list', 'Диалоги'], ['appeals', 'Апелляции'], ['checklists', 'Чек-листы']];

const brand = html`<a class="brand" href="?view=home" data-nav aria-label="Freedom Broker CQA — обзор">
  <img src="${new URL('./brand.svg', import.meta.url).href}" width="28" height="32" alt="">
  <span class="brand__name">Freedom<span>Broker</span></span>
  <span class="brand__product">CQA</span>
</a>`;

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } },
};

function readRoute() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('view') ?? 'home';
  const view = Object.hasOwn(VIEWS, requested) ? requested : 'list';
  return { view, id: params.get('id'), e: params.get('e') };
}

export function mount(container) {
  const state = {
    role: storage.get('cqa-role') === 'reviewer' ? 'reviewer' : 'user',
    route: readRoute(),
    list: { filters: { group: '', language: '', channel: '' }, selected: new Set(), version: null },
    health: null,
    timer: null,
  };

  container.innerHTML = String(html`
    <header class="topbar">
      <div class="topbar__inner">
        ${brand}
        <nav class="tabs" aria-label="Разделы">
          ${NAV.map(([view, label]) => html`<a href="?view=${view}" data-nav data-view="${view}">${label}</a>`)}
        </nav>
        <a class="btn topbar__start" href="?view=list" data-nav data-start>К диалогам</a>
        <div class="topbar__end" data-controls hidden>
          <span class="llm" data-llm></span>
          <div class="role" role="radiogroup" aria-label="Роль">
            <label><input type="radio" name="cqa-role" value="user"> Пользователь</label>
            <label><input type="radio" name="cqa-role" value="reviewer"> Проверяющий</label>
          </div>
        </div>
      </div>
    </header>
    <main class="main" data-main tabindex="-1"></main>
    <footer class="footer">
      <div class="footer__inner">
        <div class="footer__identity">
          ${brand}
          <p>Прототип для хакатона Freedom Broker</p>
        </div>
        <nav class="footer__links" aria-label="Разделы в подвале">
          ${NAV.map(([view, label]) => html`<a href="?view=${view}" data-nav>${label}</a>`)}
        </nav>
      </div>
    </footer>`);

  const main = container.querySelector('[data-main]');
  const start = container.querySelector('[data-start]');
  const controls = container.querySelector('[data-controls]');
  let renderedRoute;
  let content;

  state.schedule = (source, fn, ms) => {
    if (source !== content) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(fn, ms);
  };
  state.navigate = (search, { replace = false } = {}) => {
    history[replace ? 'replaceState' : 'pushState'](null, '', search);
    state.route = readRoute();
    render();
  };
  state.refresh = () => render({ keepScroll: true });

  async function render({ keepScroll = false } = {}) {
    clearTimeout(state.timer);
    const scroll = window.scrollY;
    const route = state.route;
    const { view } = route;
    for (const link of container.querySelectorAll('.tabs a')) {
      const active = link.dataset.view === view || (view === 'card' && link.dataset.view === 'list');
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    container.dataset.view = view;
    container.dataset.role = state.role;
    start.hidden = view !== 'home';
    controls.hidden = view === 'home';

    // Запоздалый ответ предыдущего экрана попадёт в уже отсоединённый контейнер.
    if (route !== renderedRoute) {
      renderedRoute = route;
      content = document.createElement('div');
      if (view !== 'home') content.innerHTML = '<p class="empty" role="status">Загрузка…</p>';
      main.replaceChildren(content);
    }
    await VIEWS[view].render(content, state);
    if (keepScroll && route === state.route) window.scrollTo(0, scroll);
  }

  container.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-nav]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    state.navigate(link.getAttribute('href'));
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  });

  for (const input of container.querySelectorAll('input[name=cqa-role]')) {
    input.checked = input.value === state.role;
    input.addEventListener('change', () => {
      state.role = input.value;
      storage.set('cqa-role', state.role);
      state.refresh();
    });
  }

  window.addEventListener('popstate', () => {
    state.route = readRoute();
    render();
  });

  api.health().then((health) => {
    state.health = health;
    const badge = container.querySelector('[data-llm]');
    const isMock = health.provider === 'mock';
    badge.textContent = isMock ? 'Новые оценки в тестовом режиме' : `Модель для новых оценок · ${health.model}`;
    badge.classList.toggle('llm--mock', isMock);
    badge.title = isMock ? 'Заглушка подставляет примеры баллов и ссылок без обращения к ИИ.' : '';
  }).catch(() => {});

  render();
}

const root = document.getElementById('cqa-root');
if (root) mount(root);
