export function answersFrom(result, checklist) {
  const answers = Object.fromEntries(result.criteria.map((c) => [c.id, c.answer]));
  for (const criterion of checklist.criteria.filter((c) => c.type === 'flag')) {
    answers[criterion.id] = result.gross_errors.some((g) => g.criterion_id === criterion.id) ? 'yes' : 'no';
  }
  return answers;
}
