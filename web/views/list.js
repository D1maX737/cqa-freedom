import { api } from '../api.js';
import { CHANNEL_NAMES, STATUS_NAMES, errorPanel, fmt, html, mountView, toast } from './ui.js';

const isPending = (row) => row.evaluation && (row.evaluation.status === 'queued' || row.evaluation.status === 'running');

function totalCell(e) {
  if (!e) return html`<span class="muted">не оценён</span>`;
  if (e.status !== 'done') {
    return html`<span class="status status--${e.status}" title="${e.error ?? ''}">${STATUS_NAMES[e.status]}</span>`;
  }
  const changed = e.total_final !== e.total_original;
  return html`<span class="total">${fmt(e.total_final)}</span>
    ${changed ? html`<span class="total__was">было ${fmt(e.total_original)}</span>` : ''}
    ${e.needs_review ? html`<span class="dot dot--amber" title="Часть критериев требует проверки"></span>` : ''}`;
}

function appealCell(e) {
  if (!e || (!e.appeals_open && !e.appeals_decided)) return '';
  return html`${e.appeals_open ? html`<span class="pill pill--amber">открыта: ${e.appeals_open}</span>` : ''}
    ${e.appeals_decided ? html`<span class="pill">решена: ${e.appeals_decided}</span>` : ''}`;
}

const select = (name, label, options, current) => html`<label class="field field--inline">${label}
  <select name="${name}">${options.map(([value, text]) => html`<option value="${value}" ${value === current ? 'selected' : ''}>${text}</option>`)}</select>
</label>`;

export async function render(container, state) {
  const ls = state.list;
  let rows;
  let versions;
  let groups;
  let health;
  try {
    [rows, versions, groups, health] = await Promise.all([api.conversations(ls.filters), api.checklists(), api.groups(), api.health()]);
  } catch (error) {
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }

  ls.version = versions.some((v) => v.id === ls.version) ? ls.version : versions.at(-1)?.id;
  const visible = new Set(rows.map((r) => r.conversation_id));
  for (const id of ls.selected) if (!visible.has(id)) ls.selected.delete(id);
  const allChecked = rows.length > 0 && rows.every((r) => ls.selected.has(r.conversation_id));
  // Адрес API с подписью хранится только в .env сервера; без него загрузка невозможна, остаётся импорт.
  const datasetReady = health.dataset_configured;

  const root = mountView(container, html`
    <section class="page-head">
      <h1>Диалоги</h1>
      <form class="loader" data-form="fetch">
        <label class="field field--inline">Набор
          <input name="group" value="${ls.filters.group || 'DEV'}" size="8" aria-label="group_id набора" title="group_id набора: DEV или код контрольного набора">
        </label>
        <button class="btn" type="submit" ${datasetReady ? '' : 'disabled'}>Загрузить из API</button>
        <label class="btn btn--ghost file">Импорт JSON<input type="file" accept="application/json,.json" data-input="import"></label>
        <button class="btn btn--ghost" type="button" data-paste-open>Вставить диалог</button>
        ${datasetReady ? '' : html`<p class="loader__note" data-note="dataset">API организаторов не подключено: в .env на сервере нет DATASET_URL. Добавьте его и перезапустите сервер или импортируйте JSON.</p>`}
      </form>
    </section>

    <section class="paste" data-paste hidden>
      <form class="panel paste__form" data-form="paste">
        <h2>Свой диалог</h2>
        <p class="paste__hint">По строке на реплику: «00:12 оператор: текст». Время можно не указывать, роли — клиент, оператор, бот, система.
          Диалог попадёт в набор OWN и сразу уйдёт на оценку.</p>
        <textarea name="text" rows="8" required aria-label="Текст диалога" placeholder="00:00 клиент: Здравствуйте, не могу вывести деньги
00:20 оператор: Здравствуйте, меня зовут Алия. Какое сообщение вы видите в приложении?
00:45 клиент: Пишет, что вывод ограничен"></textarea>
        <div class="paste__actions">
          ${select('language', 'Язык', [['', 'определить сам'], ['RU', 'RU'], ['KZ', 'KZ'], ['EN', 'EN']], '')}
          <button class="btn btn--primary" type="submit">Добавить и оценить</button>
          <button class="btn btn--ghost" type="button" data-paste-close>Отмена</button>
        </div>
        <p class="label-error" data-paste-error role="alert" hidden></p>
      </form>
    </section>

    <section class="toolbar">
      <form class="filters" data-form="filters">
        ${select('group', 'Набор', [['', 'все'], ...groups.map((g) => [g.group_id, `${g.group_id} (${g.total})`])], ls.filters.group)}
        ${select('language', 'Язык', [['', 'все'], ['RU', 'RU'], ['KZ', 'KZ'], ['EN', 'EN']], ls.filters.language)}
        ${select('channel', 'Канал', [['', 'все'], ['agent chat', 'чат'], ['voice call', 'звонок']], ls.filters.channel)}
      </form>
      <form class="evaluate" data-form="evaluate">
        <span class="evaluate__count">${ls.selected.size ? `Выбрано: ${ls.selected.size}` : 'Отметьте диалоги для оценки'}</span>
        ${select('version', 'Чек-лист', versions.map((v) => [v.id, `${v.id} — ${v.name}`]), ls.version)}
        <button class="btn btn--primary" type="submit" ${ls.selected.size ? '' : 'disabled'}>Оценить выбранные</button>
      </form>
    </section>

    ${rows.length === 0 ? html`<div class="empty">
      <p>Диалогов пока нет. ${datasetReady ? 'Загрузите набор DEV из API организаторов или импортируйте JSON в том же формате.' : 'Импортируйте JSON в формате API организаторов или подключите API через DATASET_URL в .env.'}</p>
    </div>` : html`
    <div class="table-wrap" role="region" aria-label="Таблица диалогов" tabindex="0">
      <table class="grid">
        <thead><tr>
          <th class="grid__check"><input type="checkbox" data-check="all" ${allChecked ? 'checked' : ''} aria-label="Выбрать все"></th>
          <th>Диалог</th><th>Канал</th><th>Язык</th><th class="num">Реплик</th>
          <th class="num">Итог</th><th>Грубая ошибка</th><th>Апелляция</th><th>Чек-лист</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => html`<tr class="${ls.selected.has(r.conversation_id) ? 'is-selected' : ''}">
            <td class="grid__check"><input type="checkbox" data-check="${r.conversation_id}" ${ls.selected.has(r.conversation_id) ? 'checked' : ''} aria-label="Выбрать ${r.conversation_id}"></td>
            <td><a href="?view=card&id=${encodeURIComponent(r.conversation_id)}" data-nav class="conv-link">${r.conversation_id}</a></td>
            <td>${CHANNEL_NAMES[r.channel] ?? r.channel}</td>
            <td>${r.language}</td>
            <td class="num">${r.turns}</td>
            <td class="num">${totalCell(r.evaluation)}</td>
            <td>${r.evaluation?.gross_error ? html`<span class="pill pill--brick">есть</span>` : ''}</td>
            <td>${appealCell(r.evaluation)}</td>
            <td class="muted">${r.evaluation?.checklist_version_id ?? ''}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>`}`);

  root.querySelector('[data-form=filters]').addEventListener('change', (event) => {
    ls.filters[event.target.name] = event.target.value;
    render(container, state);
  });

  root.querySelector('[data-form=evaluate] select').addEventListener('change', (event) => { ls.version = event.target.value; });

  // Выбор строк обновляет DOM на месте: полная перерисовка с запросом теряла бы быстрые клики.
  const syncSelection = () => {
    for (const box of root.querySelectorAll('input[data-check]:not([data-check=all])')) {
      box.checked = ls.selected.has(box.dataset.check);
      box.closest('tr').classList.toggle('is-selected', box.checked);
    }
    const all = root.querySelector('input[data-check=all]');
    if (all) all.checked = rows.length > 0 && rows.every((r) => ls.selected.has(r.conversation_id));
    root.querySelector('.evaluate__count').textContent = ls.selected.size ? `Выбрано: ${ls.selected.size}` : 'Отметьте диалоги для оценки';
    root.querySelector('[data-form=evaluate] button[type=submit]').disabled = ls.selected.size === 0;
  };

  root.addEventListener('change', (event) => {
    const box = event.target.closest('input[data-check]');
    if (!box) return;
    if (box.dataset.check === 'all') {
      for (const r of rows) (box.checked ? ls.selected.add(r.conversation_id) : ls.selected.delete(r.conversation_id));
    } else if (box.checked) ls.selected.add(box.dataset.check);
    else ls.selected.delete(box.dataset.check);
    syncSelection();
  });

  root.querySelector('[data-form=evaluate]').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { evaluations } = await api.evaluate([...ls.selected], ls.version);
      toast(`Отправлено на оценку: ${evaluations.length}`);
      ls.selected.clear();
      render(container, state);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  root.querySelector('[data-form=fetch]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const group = new FormData(event.target).get('group').trim();
    const button = event.target.querySelector('button');
    button.disabled = true;
    button.textContent = 'Загружаю…';
    try {
      const result = await api.fetchDataset(group);
      toast(`Загружено ${result.imported} диалогов (${result.group})`);
      ls.filters.group = result.group;
      render(container, state);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Загрузить из API';
    }
  });

  const paste = root.querySelector('[data-paste]');
  const pasteForm = root.querySelector('[data-form=paste]');
  const pasteError = root.querySelector('[data-paste-error]');
  root.querySelector('[data-paste-open]').addEventListener('click', () => {
    paste.hidden = false;
    pasteForm.elements.text.focus();
  });
  root.querySelector('[data-paste-close]').addEventListener('click', () => { paste.hidden = true; });
  pasteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = pasteForm.querySelector('button[type=submit]');
    button.disabled = true;
    pasteError.hidden = true;
    try {
      const added = await api.pasteConversation(pasteForm.elements.text.value, pasteForm.elements.language.value);
      try {
        await api.evaluate([added.conversation_id], ls.version);
        toast('Диалог добавлен и отправлен на оценку');
      } catch (error) {
        toast(`Диалог добавлен, но оценка не запущена: ${error.message}`, 'error');
      }
      state.navigate(`?view=card&id=${encodeURIComponent(added.conversation_id)}`);
      window.scrollTo(0, 0);
    } catch (error) {
      pasteError.textContent = error.message;
      pasteError.hidden = false;
      button.disabled = false;
    }
  });

  root.querySelector('[data-input=import]').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    const group = root.querySelector('input[name=group]').value.trim() || 'IMPORT';
    try {
      const result = await api.importConversations(JSON.parse(await file.text()), group);
      toast(`Импортировано ${result.imported} диалогов (${result.group})`);
      ls.filters.group = result.group;
      render(container, state);
    } catch (error) {
      toast(error instanceof SyntaxError ? 'Файл не является JSON' : error.message, 'error');
    }
  });

  if (rows.some(isPending)) state.schedule(container, () => render(container, state), 1500);
}
