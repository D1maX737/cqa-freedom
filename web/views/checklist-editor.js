import { api } from '../api.js';
import { errorPanel, fmt, html, mountView, toast } from './ui.js';

const TYPE_NAMES = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг без баллов' };

const parseScale = (text) => text.split(/[,;\s]+/).filter(Boolean).map((token) => (Number.isFinite(Number(token)) ? Number(token) : token));

const subtypesText = (subtypes = []) => subtypes.map((s) => [s.id, s.title, s.definition].join(' | ')).join('\n');
const parseSubtypes = (text) => text.split('\n').map((line) => line.split('|').map((p) => p.trim())).filter(([id]) => id)
  .map(([id, title = id, definition = title]) => ({ id, title, definition }));

function nextId(criteria) {
  let n = criteria.length + 1;
  while (criteria.some((c) => c.id === `c${n}`)) n += 1;
  return `c${n}`;
}

/** Подсказка, оставшаяся от другого критерия после замены на месте, увела бы модель по чужим правилам. */
function inheritedFrom(c, baseCriteria) {
  if (!c.guidance?.trim()) return null;
  return baseCriteria.find((b) => b.id !== c.id && b.guidance === c.guidance)?.id ?? null;
}

function criterionEditor(c, index, sections, baseCriteria) {
  return html`<fieldset class="ed-crit" data-index="${index}">
    <legend><span class="crit__id">${c.id}</span> ${c.title || 'Новый критерий'}</legend>
    <div class="ed-row">
      <label class="field ed-id">ID<input data-f="id" value="${c.id}" required></label>
      <label class="field ed-grow">Название<input data-f="title" value="${c.title}" required></label>
      <label class="field">Секция<select data-f="section">
        ${sections.map((s) => html`<option value="${s.id}" ${s.id === c.section ? 'selected' : ''}>${s.title}</option>`)}
      </select></label>
      <label class="field">Тип<select data-f="type">
        ${Object.entries(TYPE_NAMES).map(([value, label]) => html`<option value="${value}" ${value === c.type ? 'selected' : ''}>${label}</option>`)}
      </select></label>
      <label class="field ed-weight">Вес<input type="number" min="0" step="1" data-f="weight" value="${c.weight}" ${c.type === 'flag' ? 'disabled' : ''}></label>
    </div>
    ${c.type === 'scale' ? html`<div class="ed-scale">
      <label class="field">Ступени шкалы через запятую<input data-f="scale" value="${(c.scale ?? []).join(', ')}"></label>
      ${(c.scale ?? []).filter((s) => typeof s === 'number').sort((a, b) => b - a).map((step) => html`<label class="field ed-step">
        <span>Ступень ${step}</span><input data-f="scale_label" data-step="${step}" value="${c.scale_labels?.[step] ?? ''}" placeholder="Что означает эта ступень">
      </label>`)}
    </div>` : ''}
    ${c.type !== 'flag' ? html`<div class="ed-na">
      <label class="check"><input type="checkbox" data-f="na_allowed" ${c.na_allowed ? 'checked' : ''}> N/A разрешён</label>
      ${c.na_allowed ? html`<label class="field ed-grow">Условие N/A<input data-f="na_condition" value="${c.na_condition}" required></label>` : ''}
    </div>` : ''}
    <label class="field">Определение<textarea rows="2" data-f="definition" required>${c.definition}</textarea></label>
    <label class="field">Как оценивать: подсказка для модели<textarea rows="2" data-f="guidance">${c.guidance ?? ''}</textarea></label>
    ${inheritedFrom(c, baseCriteria) ? html`<p class="review-note">Подсказка совпадает с подсказкой ${inheritedFrom(c, baseCriteria)}: перепишите её под этот критерий, иначе модель будет оценивать по старым правилам.</p>` : ''}
    ${c.type === 'flag' ? html`<label class="field">Виды нарушений, по одному в строке: id | название | определение
      <textarea rows="3" data-f="subtypes">${subtypesText(c.subtypes)}</textarea></label>` : ''}
    <div><button type="button" class="btn btn--small btn--danger" data-action="remove">Удалить критерий</button></div>
  </fieldset>`;
}

function applyField(c, field, input) {
  switch (field) {
    case 'weight': c.weight = input.value === '' ? NaN : Number(input.value); break;
    case 'na_allowed': c.na_allowed = input.checked; if (!c.na_allowed) c.na_condition = ''; break;
    case 'scale': c.scale = parseScale(input.value); break;
    case 'scale_label': c.scale_labels = { ...c.scale_labels, [input.dataset.step]: input.value }; break;
    case 'subtypes': c.subtypes = parseSubtypes(input.value); break;
    case 'type':
      c.type = input.value;
      if (c.type === 'flag') Object.assign(c, { weight: 0, na_allowed: false, na_condition: '', subtypes: c.subtypes ?? [] });
      if (c.type === 'scale' && !Array.isArray(c.scale)) Object.assign(c, { scale: [0, 5, 10], scale_labels: {} });
      if (c.type !== 'scale') { delete c.scale; delete c.scale_labels; }
      if (c.type !== 'flag') delete c.subtypes;
      break;
    default: c[field] = input.value;
  }
}

export async function render(container, state) {
  const ed = (state.editor ??= { baseId: null, draft: null, errors: [], name: '', target: 'selected', group: '' });
  let versions;
  let groups;
  let base;
  try {
    [versions, groups] = await Promise.all([api.checklists(), api.groups()]);
    ed.baseId = versions.some((v) => v.id === ed.baseId) ? ed.baseId : versions.at(-1).id;
    base = await api.checklist(ed.baseId);
  } catch (error) {
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }
  if (!ed.draft || ed.draftOf !== base.id) {
    ed.draft = structuredClone(base.config);
    ed.draftOf = base.id;
    ed.errors = [];
  }
  ed.group ||= groups[0]?.group_id ?? '';

  const { draft } = ed;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.config);
  const weightSum = draft.criteria.reduce((sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0), 0);
  const selectedCount = state.list.selected.size;

  const root = mountView(container, html`
    <section class="page-head">
      <h1>Чек-листы</h1>
      <p class="muted">Версии неизменяемы: любая правка сохраняется как новая версия, старые оценки остаются привязаны к своей.</p>
    </section>
    <div class="editor">
      <nav class="versions" aria-label="Версии чек-листа">
        ${versions.map((v) => html`<button type="button" class="version ${v.id === base.id ? 'is-current' : ''}" data-version="${v.id}">
          <strong>${v.id}</strong> ${v.name}
          <span class="muted">${v.criteria} критериев, сумма весов ${fmt(v.total_weight)}</span>
        </button>`)}
      </nav>
      <form class="ed-form" data-form="editor" novalidate>
        <p class="ed-base">Черновик на основе ${base.id}: ${base.name}${dirty ? html` <span class="pill pill--amber">есть несохранённые изменения</span>` : ''}</p>

        <fieldset class="ed-sections">
          <legend>Секции</legend>
          ${draft.sections.map((s, i) => html`<div class="ed-row">
            <label class="field ed-grow">Название секции ${s.id}<input data-section="${i}" value="${s.title}"></label>
            <button type="button" class="btn btn--small btn--ghost" data-action="remove-section" data-section-index="${i}"
              ${draft.criteria.some((c) => c.section === s.id) ? 'disabled' : ''}
              title="${draft.criteria.some((c) => c.section === s.id) ? 'В секции есть критерии' : ''}">Удалить</button>
          </div>`)}
          <button type="button" class="btn btn--small" data-action="add-section">Добавить секцию</button>
        </fieldset>

        ${draft.criteria.map((c, i) => criterionEditor(c, i, draft.sections, base.config.criteria))}
        <button type="button" class="btn" data-action="add">Добавить критерий</button>

        <div class="ed-bar">
          <p class="ed-sum ${weightSum === 100 ? '' : 'ed-sum--warn'}">Сумма весов: ${fmt(weightSum)}${weightSum === 100 ? '' : ' — итог всё равно приводится к 100, но проверьте веса'}</p>
          ${ed.errors.length ? html`<ul class="ed-errors" role="alert">${ed.errors.map((e) => html`<li>${e}</li>`)}</ul>` : ''}
          <div class="ed-actions">
            <label class="field field--inline">Название версии<input name="version-name" value="${ed.name}" placeholder="Например: замена c5"></label>
            <button type="submit" class="btn btn--primary" ${dirty ? '' : 'disabled'}>Сохранить как новую версию</button>
            ${dirty ? html`<button type="button" class="btn btn--ghost" data-action="reset">Отменить изменения</button>` : ''}
          </div>
          <div class="ed-actions ed-apply">
            <span>Применить ${base.id} к</span>
            <label class="check"><input type="radio" name="target" value="selected" ${ed.target === 'selected' ? 'checked' : ''}> отмеченным в списке (${selectedCount})</label>
            <label class="check"><input type="radio" name="target" value="group" ${ed.target === 'group' ? 'checked' : ''}> всем диалогам набора</label>
            <select name="group" aria-label="Набор">${groups.map((g) => html`<option value="${g.group_id}" ${g.group_id === ed.group ? 'selected' : ''}>${g.group_id} (${g.total})</option>`)}</select>
            <button type="button" class="btn" data-action="apply" ${dirty ? 'disabled' : ''} title="${dirty ? 'Сначала сохраните версию' : ''}">Применить и оценить</button>
          </div>
        </div>
      </form>
    </div>`);

  const rerender = () => render(container, state);
  const form = root.querySelector('[data-form=editor]');

  form.addEventListener('input', (event) => {
    const input = event.target;
    if (ed.errors.length) {
      ed.errors = [];
      root.querySelector('.ed-errors')?.remove();
    }
    if (input.name === 'version-name') { ed.name = input.value; return; }
    if (input.dataset.section !== undefined) { draft.sections[Number(input.dataset.section)].title = input.value; return; }
    const fieldset = input.closest('[data-index]');
    if (!fieldset || !input.dataset.f) return;
    const c = draft.criteria[Number(fieldset.dataset.index)];
    if (input.dataset.f === 'scale') return;
    applyField(c, input.dataset.f, input);
    if (input.dataset.f === 'title') fieldset.querySelector('legend').lastChild.textContent = ` ${input.value || 'Новый критерий'}`;
  });

  // Поля, меняющие состав формы, перерисовывают её после изменения.
  form.addEventListener('change', (event) => {
    const input = event.target;
    if (input.name === 'target') { ed.target = input.value; return; }
    if (input.name === 'group') { ed.group = input.value; return; }
    const fieldset = input.closest('[data-index]');
    if (!fieldset || !input.dataset.f) return;
    applyField(draft.criteria[Number(fieldset.dataset.index)], input.dataset.f, input);
    if (['type', 'na_allowed', 'scale', 'weight', 'section', 'id', 'guidance'].includes(input.dataset.f)) rerender();
  });

  root.addEventListener('click', async (event) => {
    const version = event.target.closest('[data-version]');
    if (version) {
      if (dirty && !window.confirm('Несохранённые изменения пропадут. Открыть другую версию?')) return;
      ed.baseId = version.dataset.version;
      ed.draft = null;
      rerender();
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'add') {
      draft.criteria.push({
        id: nextId(draft.criteria), title: '', section: draft.sections[0]?.id ?? '', type: 'binary', weight: 0,
        na_allowed: false, na_condition: '', definition: '', guidance: '',
      });
      rerender();
    }
    if (action === 'remove') {
      const index = Number(event.target.closest('[data-index]').dataset.index);
      if (window.confirm(`Удалить критерий ${draft.criteria[index].id}?`)) { draft.criteria.splice(index, 1); rerender(); }
    }
    if (action === 'add-section') {
      let n = draft.sections.length + 1;
      while (draft.sections.some((s) => s.id === `s${n}`)) n += 1;
      draft.sections.push({ id: `s${n}`, title: 'Новая секция' });
      rerender();
    }
    if (action === 'remove-section') {
      draft.sections.splice(Number(event.target.dataset.sectionIndex), 1);
      rerender();
    }
    if (action === 'reset') {
      ed.draft = null;
      rerender();
    }
    if (action === 'apply') {
      let ids = [...state.list.selected];
      if (ed.target === 'group') ids = (await api.conversations({ group: ed.group })).map((c) => c.conversation_id);
      if (ids.length === 0) {
        toast(ed.target === 'group' ? 'В наборе нет диалогов' : 'Сначала отметьте диалоги в списке', 'error');
        return;
      }
      try {
        const { evaluations } = await api.evaluate(ids, base.id);
        toast(`Версия ${base.id} применена: на оценке ${evaluations.length} диалогов`);
        state.list.selected.clear();
        if (ed.target === 'group') state.list.filters.group = ed.group;
        state.navigate('?view=list');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const created = await api.createChecklist(ed.name.trim() || `Правка ${base.id}`, draft);
      toast(`Сохранена версия ${created.id}`);
      Object.assign(ed, { baseId: created.id, draft: null, name: '', errors: [] });
      state.list.version = created.id;
    } catch (error) {
      ed.errors = error.details?.length ? error.details : [error.message];
    }
    rerender();
  });
}
