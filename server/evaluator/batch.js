import { runPool } from './queue.js';
import { runEvaluation } from './run.js';

export function parseArgs(argv) {
  const args = { group: null, checklist: null, concurrency: null, force: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--checklist') args.checklist = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--force') args.force = true;
    else if (!arg.startsWith('--')) args.group = arg;
  }
  return args;
}

/** Уже оценённые этой версией диалоги пропускаются: повторная оценка стоит денег. */
export function planBatch(db, { group, versionId, force, limit = null }) {
  const ids = db.conversations.list(group).map((c) => c.conversation_id)
    .filter((id) => force || db.evaluations.latestFor(id, versionId)?.status !== 'done');
  return limit ? ids.slice(0, limit) : ids;
}

export async function runBatch({ db, llm, ids, versionId, concurrency, kbDocs, uiLanguage, onProgress = () => {} }) {
  const created = ids.map((id) => db.evaluations.create({ conversation_id: id, checklist_version_id: versionId, provider: llm.name, model: llm.model }));
  let finished = 0;
  await runPool(created, concurrency, async (evaluation) => {
    await runEvaluation({ db, llm, evaluationId: evaluation.id, kbDocs, uiLanguage });
    finished += 1;
    onProgress(finished, created.length, db.evaluations.get(evaluation.id));
  });

  const results = created.map((e) => db.evaluations.get(e.id));
  const done = results.filter((e) => e.status === 'done');
  const sum = (key) => results.reduce((total, e) => total + (e[key] ?? 0), 0);
  return {
    done: done.length,
    failed: results.length - done.length,
    needs_review: done.filter((e) => e.needs_review).length,
    retried: done.filter((e) => e.attempts > 1).length,
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cost_usd: sum('cost_usd'),
    cost_per_evaluation: done.length ? sum('cost_usd') / done.length : null,
    errors: results.filter((e) => e.status === 'failed').map((e) => `${e.conversation_id}: ${e.error}`),
  };
}
