// Чистые функции расчёта. Порядок задан стр. 2 чек-листа организаторов.

/** Округление вверх на границе. Сначала снимаем двоичную погрешность, иначе 85.385 даёт 85.38. */
export function round2(value) {
  const clean = Number(value.toPrecision(12));
  if (Math.abs(clean) < 1e-6) return 0;
  return Number(`${Math.round(Number(`${clean}e2`))}e-2`);
}

function rawScore(criterion, answer) {
  if (criterion.type === 'binary') {
    if (answer === 'yes') return criterion.weight;
    if (answer === 'no') return 0;
    return null;
  }
  const value = answer === null || answer === undefined || answer === '' ? NaN : Number(answer);
  if (!criterion.scale.includes(value)) return null;
  return (value / Math.max(...criterion.scale)) * criterion.weight;
}

export function computeCriterion(criterion, answer) {
  const base = { criterion_id: criterion.id, type: criterion.type, weight: criterion.weight, answer: answer ?? null };
  if (criterion.type === 'flag') {
    return { ...base, applicable: false, pending: answer !== 'yes' && answer !== 'no', score: null };
  }
  if (answer === 'na' && criterion.na_allowed) return { ...base, applicable: false, pending: false, score: null };
  const score = answer === 'na' ? null : rawScore(criterion, answer);
  return { ...base, applicable: true, pending: score === null, score };
}

function summarize(results) {
  const counted = results.filter((r) => r.applicable && !r.pending && r.weight > 0);
  const weight = counted.reduce((sum, r) => sum + r.weight, 0);
  const score = counted.reduce((sum, r) => sum + r.score, 0);
  return { applicable_weight: weight, score, total: weight > 0 ? round2((score / weight) * 100) : null };
}

export function computeCriteria(checklist, answers) {
  return checklist.criteria.map((c) => computeCriterion(c, answers[c.id]));
}

export function computeTotal(checklist, answers) {
  return summarize(computeCriteria(checklist, answers)).total;
}

export function computeSections(checklist, answers) {
  const results = computeCriteria(checklist, answers);
  return checklist.sections.map((section) => {
    const own = results.filter((r) => checklist.criteria.find((c) => c.id === r.criterion_id).section === section.id);
    return { id: section.id, title: section.title, ...summarize(own) };
  });
}

export function computeAll(checklist, answers) {
  const results = computeCriteria(checklist, answers);
  const { total, applicable_weight: applicableWeight } = summarize(results);
  const redistribute = (value) => (applicableWeight > 0 ? round2((value / applicableWeight) * 100) : null);

  const criteria = Object.fromEntries(results.map((r) => {
    const counted = r.applicable && !r.pending && r.weight > 0;
    return [r.criterion_id, {
      ...r,
      score: r.score === null ? null : round2(r.score),
      effective_weight: counted ? redistribute(r.weight) : null,
      effective_score: counted ? redistribute(r.score) : null,
    }];
  }));

  return {
    total,
    applicable_weight: applicableWeight,
    incomplete: results.some((r) => r.pending),
    gross_error: results.some((r) => r.type === 'flag' && r.answer === 'yes'),
    sections: computeSections(checklist, answers),
    criteria,
  };
}
