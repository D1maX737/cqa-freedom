// Какую версию чек-листа показывать по умолчанию: последнюю, которой уже оценивали моделью.
// Свежая версия из редактора без оценок не должна прятать сводку и точность.

/** Последняя версия с завершёнными оценками моделью (не заглушкой) в наборе; иначе просто последняя. */
export function latestEvaluatedVersion(db, groupId) {
  const versions = db.checklists.list();
  const evaluated = new Set();
  for (const conversation of db.conversations.list(groupId || undefined)) {
    for (const e of db.evaluations.listFor(conversation.conversation_id)) {
      if (e.status === 'done' && e.provider !== 'mock') evaluated.add(e.checklist_version_id);
    }
  }
  return [...versions].reverse().find((v) => evaluated.has(v.id)) ?? versions.at(-1) ?? null;
}
