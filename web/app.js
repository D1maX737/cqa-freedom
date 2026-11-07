import { api } from './api.js';
import { html } from './views/ui.js';
import * as list from './views/list.js';
import * as card from './views/card.js';
import * as appeals from './views/appeals.js';
import * as checklists from './views/checklist-editor.js';

const VIEWS = { list, card, appeals, checklists };
const NAV = [['list', 'Диалоги'], ['appeals', 'Апелляции'], ['checklists', 'Чек-листы']];

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } },
};

function readRoute() {
  const params = new URLSearchParams(location.search);
  const view = VIEWS[params.get('view')] ? params.get('view') : 'list';
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
      <a class="brand" href="?view=list" data-nav>Контроль качества диалогов</a>
      <nav class="tabs" aria-label="Разделы">
        ${NAV.map(([view, label]) => html`<a href="?view=${view}" data-nav data-view="${view}">${label}</a>`)}
      </nav>
      <div class="topbar__end">
        <span class="llm" data-llm></span>
        <div class="role" role="radiogroup" aria-label="Роль">
          <label><input type="radio" name="cqa-role" value="user"> Пользователь</label>
          <label><input type="radio" name="cqa-role" value="reviewer"> Проверяющий</label>
        </div>
      </div>
    </header>
    <main class="main" data-main></main>`);

  const main = container.querySelector('[data-main]');

  state.schedule = (fn, ms) => {
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
    for (const link of container.querySelectorAll('.tabs a')) {
      const active = link.dataset.view === state.route.view || (state.route.view === 'card' && link.dataset.view === 'list');
      link.toggleAttribute('aria-current', active);
    }
    container.dataset.role = state.role;
    await VIEWS[state.route.view].render(main, state);
    if (keepScroll) window.scrollTo(0, scroll);
  }

  container.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-nav]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    state.navigate(link.getAttribute('href'));
    window.scrollTo(0, 0);
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
    badge.textContent = isMock ? 'Оценки: заглушка без LLM' : `Модель: ${health.model}`;
    badge.classList.toggle('llm--mock', isMock);
    badge.title = isMock ? 'LLM_PROVIDER=mock: ответы детерминированные, для проверки интерфейса' : '';
  }).catch(() => {});

  render();
}

const root = document.getElementById('cqa-root');
if (root) mount(root);
