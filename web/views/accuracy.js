// Точность модели против слепой ручной разметки и очередь разметки.
import { api } from '../api.js';
import { answerText, errorPanel, html, mountView } from './ui.js';
import { labelPrefs, nextUnlabeled } from './label.js';

const LANGUAGES = [['', 'все'], ['RU', 'RU'], ['KZ', 'KZ'], ['EN', 'EN']];
const pct = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`);
const ciText = (b) => (b.ci ? `, 95% ДИ ${pct(b.ci[0])}–${pct(b.ci[1])}` : '');
const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }));

const select = (name, label, options, current) => html`<label class="field field--inline">${label}
  <select name="${name}">${options.map(([value, text]) => html`<option value="${value}" ${value === current ? 'selected' : ''}>${text}</option>`)}</select>
</label>`;

function bucketRow(title, b) {
  return html`<tr><td>${title}</td><td class="num">${b.cells}</td><td class="num">${b.matched}</td><td class="num"><strong>${pct(b.rate)}</strong></td></tr>`;
}

function bucketTable(caption, firstColumn, rows) {
  return html`<div class="table-wrap"><table class="grid">
    <caption class="acc-caption">${caption}</caption>
    <thead><tr><th>${firstColumn}</th><th class="num">Ответов</th><th class="num">Совпало</th><th class="num">Совпадение</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function progress(conversations, labels) {
  const labeled = new Set(labels.map((l) => l.conversation_id));
  const languages = [...new Set(conversations.map((c) => c.language))];
  return {
    total: conversations.length,
    done: conversations.filter((c) => labeled.has(c.conversation_id)).length,
    byLanguage: languages.map((language) => {
      const own = conversations.filter((c) => c.language === language);
      return { language, total: own.length, done: own.filter((c) => labeled.has(c.conversation_id)).length };
    }),
    labelers: [...new Set(labels.map((l) => l.labeler))].map((name) => ({ name, count: labels.filter((l) => l.labeler === name).length })),
  };
}

function results(report, criteria) {
  const { coverage } = report;
  if (!coverage.compared) {
    return html`<div class="empty"><p>Пока не с чем сравнивать. Нужны слепая разметка и оценка моделью тех же диалогов этим чек-листом.
      Сейчас размечено ${coverage.labeled} из ${coverage.conversations}, оценено моделью ${coverage.evaluated}.</p></div>`;
  }
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const answer = (value, id) => (value === null ? 'нет ответа' : answerText(value, byId.get(id) ?? { type: 'binary' }));
  const { gross, total_deviation: deviation, by_split: split } = report;
  return html`
    <dl class="acc-stats">
      <div><dt>Совпадение с разметкой</dt><dd>${pct(report.overall.rate)}</dd><p>${report.overall.matched} из ${report.overall.cells} ответов${ciText(report.overall)}</p></div>
      <div><dt>Без спорных ответов</dt><dd>${pct(report.clear.rate)}</dd><p>${report.clear.matched} из ${report.clear.cells}${ciText(report.clear)}</p></div>
      <div><dt>Грубые ошибки</dt><dd>${gross.found} из ${gross.human}</dd><p>ложных срабатываний: ${gross.false_alarms}</p></div>
      <div><dt>Отклонение итога</dt><dd>±${num(deviation.mean)}</dd><p>в среднем, максимум ${num(deviation.max)}</p></div>
      <div><dt>κ Коэна</dt><dd>${num(report.kappa)}</dd><p>согласие с поправкой на случайность</p></div>
    </dl>
    <p class="muted acc-note">Сравнено диалогов: ${coverage.compared} из ${coverage.conversations}. Чек-лист ${report.checklist_version_id},
      модель ${report.models.join(', ') || '—'}. Сравнивается исходный ответ модели, до апелляций.
      ${report.mock_skipped ? `Оценки заглушкой не учитываются: ${report.mock_skipped}.` : ''}</p>
    <div class="acc-tables">
      ${bucketTable('По критериям', 'Критерий', report.by_criterion.map((c) => bucketRow(`${c.id} ${c.title}`, c)))}
      <div class="acc-tables__side">
        ${bucketTable('По языкам', 'Язык', report.by_language.map((l) => bucketRow(l.language, l)))}
        ${bucketTable('Честная проверка', 'Диалоги', html`${bucketRow('Не использовались при настройке промпта', split.holdout)}
          ${split.tuning.cells ? bucketRow('На них настраивали промпт', split.tuning) : ''}`)}
      </div>
    </div>
    ${report.agreement.conversations ? html`<p class="acc-note">Размечавшие между собой: совпало ${report.agreement.matched} из ${report.agreement.cells} ответов
      в ${report.agreement.conversations} диалогах, размеченных несколькими.</p>` : ''}
    ${report.mismatches.length ? html`<details class="acc-mismatches">
      <summary>Расхождения с разметкой: ${report.mismatches.length}</summary>
      <div class="table-wrap"><table class="grid">
        <thead><tr><th>Диалог</th><th>Критерий</th><th>Разметка</th><th>Модель</th><th></th></tr></thead>
        <tbody>${report.mismatches.map((m) => html`<tr>
          <td><a class="conv-link" href="?view=card&id=${encodeURIComponent(m.conversation_id)}" data-nav>${m.conversation_id}</a></td>
          <td>${m.criterion_id} ${byId.get(m.criterion_id)?.title ?? ''}</td>
          <td>${m.human.map((v) => answer(v, m.criterion_id)).join(' или ')}</td>
          <td>${answer(m.model, m.criterion_id)}</td>
          <td>${m.disputed ? html`<span class="pill pill--amber">спорно</span>` : ''}</td>
        </tr>`)}</tbody>
      </table></div>
    </details>` : ''}`;
}

export async function render(container, state) {
  const route = state.route;
  const queue = labelPrefs.queue();
  let versions;
  let groups;
  let report;
  let labels;
  let conversations;
  let checklist;
  try {
    [versions, groups] = await Promise.all([api.checklists(), api.groups()]);
    const group = groups.some((g) => g.group_id === queue.group) ? queue.group
      : (groups.find((g) => g.group_id === 'DEV') ?? groups[0])?.group_id ?? '';
    // Без выбора — последняя версия, которой оценивали: её сервер и подставит.
    const chosen = versions.some((v) => v.id === queue.version) ? queue.version : undefined;
    [report, { labels }, conversations] = await Promise.all([api.accuracy({ group, version: chosen }), api.labels(), api.conversations({ group })]);
    const version = report.checklist_version_id;
    Object.assign(queue, { group, version });
    checklist = await api.checklist(version);
  } catch (error) {
    if (route !== state.route) return;
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }
  if (route !== state.route) return;

  const stats = progress(conversations, labels);
  const root = mountView(container, html`
    <section class="page-head">
      <h1>Точность</h1>
      <p class="acc-lead">Совпадение ответов модели со слепой разметкой: на странице разметки ответов модели нет. Кто размечал — ниже, в строке «Разметили»; разметчик claude — это независимая модель, а не человек.</p>
    </section>

    <section class="panel acc-queue" aria-labelledby="queue-title">
      <h2 id="queue-title">Разметка</h2>
      <p>Размечено ${stats.done} из ${stats.total}${stats.byLanguage.length ? html`: ${stats.byLanguage.map((l) => `${l.language} ${l.done}/${l.total}`).join(', ')}` : ''}.
        ${stats.labelers.length ? html`Разметили: ${stats.labelers.map((l) => `${l.name} — ${l.count}`).join(', ')}.` : ''}</p>
      <form class="acc-queue__form" data-form="queue">
        ${select('group', 'Набор', groups.map((g) => [g.group_id, `${g.group_id} (${g.total})`]), queue.group)}
        ${select('version', 'Чек-лист', versions.map((v) => [v.id, `${v.id} · ${v.name}`]), queue.version)}
        ${select('language', 'Язык очереди', LANGUAGES, queue.language ?? '')}
        <label class="field field--inline">Кто размечает
          <input name="labeler" value="${labelPrefs.labeler()}" size="12" autocomplete="nickname" placeholder="Имя">
        </label>
        <button class="btn btn--primary" type="submit">Размечать</button>
      </form>
      <p class="muted acc-hint">Разметка сохраняется в файл <code>eval/labels/&lt;имя&gt;.json</code>. Закоммитьте его и сделайте <code>git pull</code>,
        чтобы видеть разметку остальных. Чтобы не размечать одно и то же, разделите языки между собой.</p>
      <p class="label-error" data-error role="alert" hidden></p>
    </section>

    <section class="acc-results" aria-labelledby="results-title">
      <h2 id="results-title">Результат</h2>
      ${results(report, checklist.config.criteria)}
    </section>`);

  const form = root.querySelector('[data-form=queue]');
  const errorBox = root.querySelector('[data-error]');
  form.addEventListener('change', (event) => {
    if (event.target.name === 'labeler') return;
    labelPrefs.setQueue({ ...queue, [event.target.name]: event.target.value });
    if (event.target.name !== 'language') state.refresh();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = form.elements.labeler.value.trim();
    if (!name) {
      errorBox.textContent = 'Укажите, кто размечает: имя станет названием вашего файла разметки.';
      errorBox.hidden = false;
      form.elements.labeler.focus();
      return;
    }
    labelPrefs.setLabeler(name);
    const language = form.elements.language.value;
    labelPrefs.setQueue({ ...queue, language });
    const pool = conversations.filter((c) => !language || c.language === language);
    const next = nextUnlabeled(pool, new Set(labels.map((l) => l.conversation_id)), null);
    if (!next) {
      errorBox.textContent = 'В этой очереди всё размечено. Выберите другой язык или сделайте git pull, чтобы увидеть разметку остальных.';
      errorBox.hidden = false;
      return;
    }
    state.navigate(`?view=label&id=${encodeURIComponent(next)}`);
    window.scrollTo(0, 0);
  });
}
