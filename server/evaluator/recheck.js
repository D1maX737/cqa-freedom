// Перепроверка рискованных ответов вторым проходом («контролёр»). Включается RECHECK=1:
// это лишний запрос на диалог, а польза измеряется только на размеченном эталоне.
const LOW_CONFIDENCE = 0.6;

/** Ответы, где ошибка обходится дороже всего: «Нет», N/A, неполная шкала, низкая уверенность, грубые ошибки. */
export function riskyCriteria(response, checklist) {
  const items = new Map((Array.isArray(response?.criteria) ? response.criteria : []).map((c) => [c.id, c]));
  const criteria = checklist.criteria.filter((c) => c.type !== 'flag' && items.has(c.id)).filter((c) => {
    const item = items.get(c.id);
    const answer = String(item.answer);
    const partial = c.type === 'scale' && answer !== 'na' && Number(answer) < Math.max(...c.scale);
    const unsure = typeof item.confidence === 'number' && item.confidence < LOW_CONFIDENCE;
    return answer === 'no' || answer === 'na' || partial || unsure;
  }).map((c) => c.id);
  return { criteria, gross: (Array.isArray(response?.gross_errors) ? response.gross_errors : []).length > 0 };
}

export function buildRecheckPrompt(prompt, first, risky) {
  const list = [...risky.criteria, ...(risky.gross ? ['грубые ошибки'] : [])].join(', ');
  return {
    ...prompt,
    user: `${prompt.user}

<first_answer>
${JSON.stringify(first)}
</first_answer>

Ты контролёр. Выше — ответ первого аналитика. Перепроверь заново по транскрипту и правилам чек-листа: ${list}.
Первый ответ мог ошибиться в обе стороны: поставить «no», хотя оператор сделал нужное другими словами, или "na", хотя условие критерия не выполнено, — и наоборот. Меняй ответ, только если на это указывают реплики.
Верни полный ответ в том же формате; по остальным критериям повтори первый ответ.`,
  };
}

/** Из перепроверки берутся только рискованные критерии; грубые ошибки — только если их перепроверяли. */
export function mergeRecheck(first, second, risky) {
  const byId = new Map((Array.isArray(second?.criteria) ? second.criteria : []).map((c) => [c.id, c]));
  const changed = [];
  const criteria = first.criteria.map((item) => {
    if (!risky.criteria.includes(item.id) || !byId.has(item.id)) return item;
    const next = byId.get(item.id);
    if (String(next.answer) !== String(item.answer)) changed.push({ id: item.id, from: String(item.answer), to: String(next.answer) });
    return next;
  });
  let grossErrors = first.gross_errors;
  if (risky.gross && Array.isArray(second?.gross_errors)) {
    grossErrors = second.gross_errors;
    if (grossErrors.length !== (first.gross_errors ?? []).length) {
      changed.push({ id: 'gross', from: String((first.gross_errors ?? []).length), to: String(grossErrors.length) });
    }
  }
  return { merged: { ...first, criteria, gross_errors: grossErrors }, changed };
}
