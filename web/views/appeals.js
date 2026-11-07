import { mountView, html } from './ui.js';

// TODO(этап 6): очередь проверяющего. Интерфейс: render(container, state), данные — api.appeals(status).
export async function render(container) {
  mountView(container, html`<p class="empty">Очередь апелляций появится на этапе 6.</p>`);
}
