import { mountView, html } from './ui.js';

// TODO(этап 7): редактор чек-листа. Интерфейс: render(container, state), данные — api.checklists(), api.createChecklist(name, config).
export async function render(container) {
  mountView(container, html`<p class="empty">Редактор чек-листа появится на этапе 7.</p>`);
}
