// Слепая разметка эталона: человек отвечает по чек-листу, не видя ответов модели.
import { api } from '../api.js';
import { CHANNEL_NAMES, errorPanel, html, mountView, toast } from './ui.js';
import { messageRow, seek } from './card.js';

const LANGUAGE_NAMES = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* приватный режим */ }
}

/** Кто размечает и какую очередь: общие настройки страниц «Точность» и «Разметка». */
export const labelPrefs = {
  labeler: () => read('cqa-labeler') ?? '',
  setLabeler: (name) => write('cqa-labeler', name),
  queue() {
    try { return JSON.parse(read('cqa-label-queue') ?? '{}'); } catch { return {}; }
  },
  setQueue: (queue) => write('cqa-label-queue', JSON.stringify(queue)),
};

/** Те же значения, что принимает сервер: у грубой ошибки только «есть» или «нет». */
export function labelValues(criterion) {
  if (criterion.type === 'flag') return ['yes', 'no'];
  const values = criterion.type === 'scale' ? [...criterion.scale].sort((a, b) => a - b).map(String) : ['yes', 'no'];
  return criterion.na_allowed ? [...values, 'na'] : values;
}

function optionText(criterion, value) {
  if (value === 'na') return 'N/A';
  if (criterion.type === 'flag') return value === 'yes' ? 'Есть' : 'Нет';
  if (criterion.type === 'scale') return value;
  return value === 'yes' ? 'Да' : 'Нет';
}

/** Следующий диалог очереди без разметки: сначала после текущего, потом с начала. */
export function nextUnlabeled(conversations, labeledIds, currentId) {
  const ids = conversations.map((c) => c.conversation_id).sort();
  const open = ids.filter((id) => id !== currentId && !labeledIds.has(id));
  return open.find((id) => id > (currentId ?? '')) ?? open[0] ?? null;
}

function criterionField(criterion, current) {
  const scale = criterion.type === 'scale';
  const subtypes = criterion.type === 'flag' ? criterion.subtypes ?? [] : [];
  return html`<fieldset class="label-crit" id="lc-${criterion.id}" data-crit="${criterion.id}">
    <legend><span class="crit__id">${criterion.id}</span> ${criterion.title}</legend>
    ${criterion.definition ? html`<p class="label-crit__def">${criterion.definition}</p>` : ''}
    <div class="label-crit__options${scale ? ' label-crit__options--scale' : ''}">
      ${labelValues(criterion).map((value) => html`<label class="label-opt">
        <input type="radio" name="${criterion.id}" value="${value}" ${current?.value === value ? 'checked' : ''}>
        <span><strong>${optionText(criterion, value)}</strong>${scale && criterion.scale_labels?.[value]
          ? html`<span class="label-opt__hint">${criterion.scale_labels[value]}</span>` : ''}</span>
      </label>`)}
    </div>
    ${criterion.na_allowed && criterion.na_condition ? html`<p class="label-crit__na">N/A, если: ${criterion.na_condition}</p>` : ''}
    ${subtypes.length ? html`<details class="crit__rule"><summary>Что считается грубой ошибкой</summary>
      <ul class="label-crit__subtypes">${subtypes.map((s) => html`<li><strong>${s.title}</strong>${s.definition ? `. ${s.definition}` : ''}</li>`)}</ul>
    </details>` : ''}
    <div class="label-crit__extra">
      <label class="label-crit__disputed"><input type="checkbox" name="${criterion.id}__disputed" ${current?.disputed ? 'checked' : ''}> Спорно</label>
      <input class="label-crit__note" name="${criterion.id}__note" value="${current?.note ?? ''}" maxlength="500"
        placeholder="Комментарий, если нужен" aria-label="Комментарий к ${criterion.id}">
    </div>
  </fieldset>`;
}

export async function render(container, state) {
  const route = state.route;
  const id = route.id;
  const queue = labelPrefs.queue();
  let data;
  let versions;
  let labels;
  let conversations;
  let checklist;
  try {
    [data, versions, { labels }, conversations] = await Promise.all([
      api.conversation(id), api.checklists(), api.labels(), api.conversations({ group: queue.group, language: queue.language }),
    ]);
    const versionId = versions.some((v) => v.id === queue.version) ? queue.version : versions[0]?.id;
    checklist = await api.checklist(versionId);
  } catch (error) {
    if (route !== state.route) return;
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }
  if (route !== state.route) return;

  const conv = data.conversation;
  // Открыли по ссылке без настроенной очереди — очередь из набора этого диалога.
  if (!queue.group) conversations = conversations.filter((c) => c.group_id === conv.group_id);
  const isVoice = conv.channel === 'voice call';
  const labeler = labelPrefs.labeler();
  const mine = labels.find((l) => l.conversation_id === id && l.labeler === labeler.trim().toLowerCase().replace(/\s+/g, '-'));
  const others = new Set(labels.filter((l) => l.conversation_id === id).map((l) => l.labeler));
  const labeledIds = new Set(labels.map((l) => l.conversation_id));
  const done = conversations.filter((c) => labeledIds.has(c.conversation_id)).length;
  const sections = checklist.config.sections
    .map((s) => ({ ...s, criteria: checklist.config.criteria.filter((c) => c.section === s.id) }))
    .filter((s) => s.criteria.length);

  const root = mountView(container, html`
    <section class="page-head page-head--card">
      <a href="?view=accuracy" data-nav class="back">К точности</a>
      <h1>Разметка ${conv.conversation_id}</h1>
      <p class="chips"><span class="chip">${CHANNEL_NAMES[conv.channel] ?? conv.channel}</span>
        <span class="chip">${LANGUAGE_NAMES[conv.language] ?? conv.language}</span>
        <span class="chip">Реплик ${conv.messages.length}</span>
        <span class="chip">Размечено в очереди ${done} из ${conversations.length}</span></p>
    </section>
    <p class="label-blind">Ответы модели здесь скрыты. Отметьте, как оценили бы сами по чек-листу ${checklist.id}.
      ${others.size ? html`Этот диалог уже размечали: ${[...others].join(', ')}.` : ''}</p>
    <div class="card">
      <section class="transcript" aria-labelledby="transcript-title">
        <header class="transcript__head">
          <h2 id="transcript-title">Реплики диалога</h2>
          <p>Оценивается только оператор. Бот и система — контекст.</p>
        </header>
        ${isVoice && conv.has_audio ? html`<div class="player"><audio controls preload="none" src="${api.audioUrl(conv.conversation_id)}"></audio></div>` : ''}
        <div class="transcript__list">${conv.messages.map((m) => messageRow(m, [], isVoice))}</div>
      </section>
      <form class="result label-form" data-form="label" novalidate>
        <label class="field">Кто размечает
          <input name="labeler" value="${labeler}" required autocomplete="nickname" placeholder="Например, Дима">
        </label>
        ${sections.map((s) => html`<section class="label-group"><h3>${s.title}</h3>
          ${s.criteria.map((c) => criterionField(c, mine?.criteria?.[c.id]))}</section>`)}
        <p class="label-error" data-error role="alert" hidden></p>
        <div class="label-actions">
          <button class="btn btn--primary" type="submit" data-next="1">Сохранить и следующий</button>
          <button class="btn" type="submit">Сохранить</button>
        </div>
      </form>
    </div>`);

  const form = root.querySelector('[data-form=label]');
  const errorBox = root.querySelector('[data-error]');
  const audio = root.querySelector('audio');
  root.addEventListener('click', (event) => {
    const play = event.target.closest('[data-seek]');
    if (play && audio) seek(audio, Number(play.dataset.seek), { play: true });
  });
  form.addEventListener('change', (event) => {
    event.target.closest('.label-crit')?.classList.remove('is-missing');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const goNext = event.submitter?.dataset.next === '1';
    const name = form.elements.labeler.value.trim();
    const criteria = {};
    const missing = [];
    for (const c of checklist.config.criteria) {
      const checked = form.querySelector(`input[name="${CSS.escape(c.id)}"]:checked`);
      if (!checked) {
        missing.push(c);
        continue;
      }
      criteria[c.id] = {
        value: checked.value,
        disputed: form.elements.namedItem(`${c.id}__disputed`).checked,
        note: form.elements.namedItem(`${c.id}__note`).value,
      };
    }
    for (const node of form.querySelectorAll('.label-crit')) node.classList.toggle('is-missing', missing.some((c) => c.id === node.dataset.crit));
    if (!name || missing.length) {
      errorBox.textContent = !name ? 'Укажите, кто размечает: имя станет названием вашего файла разметки.'
        : `Не выбран ответ: ${missing.map((c) => `${c.id} ${c.title}`).join(', ')}.`;
      errorBox.hidden = false;
      (!name ? form.elements.labeler : form.querySelector(`#lc-${CSS.escape(missing[0].id)}`)).scrollIntoView({ block: 'center' });
      return;
    }
    errorBox.hidden = true;
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      await api.saveLabel(id, { labeler: name, checklist_version_id: checklist.id, criteria });
      labelPrefs.setLabeler(name);
      labeledIds.add(id);
      if (!goNext) {
        toast('Разметка сохранена');
        state.refresh();
        return;
      }
      const next = nextUnlabeled(conversations, labeledIds, id);
      toast(next ? 'Разметка сохранена' : 'Разметка сохранена. В очереди больше нет диалогов');
      state.navigate(next ? `?view=label&id=${encodeURIComponent(next)}` : '?view=accuracy');
      window.scrollTo(0, 0);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      for (const button of form.querySelectorAll('button')) button.disabled = false;
    }
  });
}
