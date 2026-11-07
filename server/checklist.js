import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const TYPES = new Set(['binary', 'scale', 'flag']);

export function loadSeedChecklist() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'checklists', 'checklist.v1.json'), 'utf8'));
}

const isScaleValid = (scale) => Array.isArray(scale)
  && scale.length >= 2
  && scale.every((step) => typeof step === 'number' && Number.isFinite(step) && step >= 0)
  && new Set(scale).size === scale.length
  && Math.max(...scale) > 0;

export function validateChecklist(checklist) {
  const errors = [];
  const sections = Array.isArray(checklist?.sections) ? checklist.sections : [];
  const criteria = Array.isArray(checklist?.criteria) ? checklist.criteria : [];
  if (sections.length === 0) errors.push('Нужна хотя бы одна секция');
  if (criteria.length === 0) errors.push('Нужен хотя бы один критерий');

  const sectionIds = new Set(sections.map((s) => s.id));
  const seen = new Set();
  const codes = new Set();
  for (const c of criteria) {
    const label = c.id || c.title || 'критерий без id';
    if (!c.id) errors.push('У критерия нет id');
    if (seen.has(c.id)) errors.push(`id ${c.id} повторяется`);
    seen.add(c.id);
    // Код критерия в results.json организаторов. Необязателен: без него версию нельзя выгрузить.
    if (c.code) {
      if (!/^[a-z][a-z0-9_]*$/.test(c.code)) errors.push(`${label}: код «${c.code}» — только латиница в нижнем регистре, цифры и _`);
      if (codes.has(c.code)) errors.push(`код ${c.code} повторяется`);
      codes.add(c.code);
    }
    if (!c.title?.trim()) errors.push(`${label}: нет названия`);
    if (!c.definition?.trim()) errors.push(`${label}: нет определения`);
    if (!sectionIds.has(c.section)) errors.push(`${label}: секция «${c.section}» не найдена`);
    if (!TYPES.has(c.type)) errors.push(`${label}: неизвестный тип «${c.type}»`);
    if (!Number.isFinite(c.weight) || c.weight < 0) errors.push(`${label}: вес должен быть числом не меньше нуля`);
    if (c.type === 'flag' && c.weight !== 0) errors.push(`${label}: у флага вес должен быть 0`);
    if (c.type === 'scale' && !isScaleValid(c.scale)) {
      errors.push(`${label}: шкале нужны минимум две разные ступени, числа не меньше нуля, максимум больше нуля`);
    }
    if (c.na_allowed && !c.na_condition?.trim()) errors.push(`${label}: для N/A нужно условие`);
  }
  return errors;
}

export const totalWeight = (checklist) => checklist.criteria.reduce((sum, c) => sum + (c.weight || 0), 0);

export function checklistWarnings(checklist) {
  const sum = totalWeight(checklist);
  return sum === 100 ? [] : [`Сумма весов ${sum}, а не 100: итог всё равно приводится к шкале 100`];
}

/** Типы грубых ошибок для всех критериев-флагов. Флаг без подтипов проверяется как один тип. */
export function flagTypes(checklist) {
  return checklist.criteria.filter((c) => c.type === 'flag').flatMap((c) => (c.subtypes?.length
    ? c.subtypes.map((s) => ({ ...s, criterion_id: c.id }))
    : [{ id: c.id, title: c.title, definition: c.definition, criterion_id: c.id }]));
}

export function allowedAnswers(criterion) {
  const values = criterion.type === 'scale'
    ? [...criterion.scale].sort((a, b) => a - b).map(String)
    : ['yes', 'no'];
  return criterion.na_allowed ? [...values, 'na'] : values;
}
