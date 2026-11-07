import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { checklistWarnings, loadSeedChecklist, totalWeight, validateChecklist } from './checklist.js';
import { fetchDataset, normalizeImportBody, resolveAudioUrl } from './datasource.js';
import { createEvaluationQueue } from './evaluator/queue.js';
import { configuredModel } from './llm/index.js';
import { runEvaluation } from './evaluator/run.js';
import { normalizeConversation } from './normalize.js';
import { collectAccuracy } from './accuracy.js';
import { collectOverview } from './overview.js';
import { coachCriterion } from './coaching.js';
import { parsePastedDialog } from './paste.js';
import { readLabels, saveLabel, validateLabel } from './labels.js';
import { buildEvaluationView, decisionValues, fragmentFor } from './results.js';

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const requireText = (value, message) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, message);
  return value.trim();
};

export function createApp({ db, settings, createLlm, kbDocs, fetchImpl = fetch }) {
  if (db.checklists.list().length === 0) db.checklists.create('Чек-лист организаторов', loadSeedChecklist());

  const queue = createEvaluationQueue({
    concurrency: settings.llmConcurrency,
    run: ({ evaluationId, llm }) => runEvaluation({
      db, llm, evaluationId, kbDocs, uiLanguage: settings.uiLanguage, usePrecedents: settings.usePrecedents !== false, recheck: settings.recheck === true,
    }),
  });

  const view = (evaluation) => ({
    ...buildEvaluationView(evaluation, db.checklists.get(evaluation.checklist_version_id), db.appeals.forEvaluation(evaluation.id)),
    coaching: db.coaching.forEvaluation(evaluation.id),
  });
  const getEvaluation = (id) => {
    const evaluation = db.evaluations.get(id);
    if (!evaluation) throw new HttpError(404, 'Оценка не найдена');
    return evaluation;
  };
  const summary = (evaluation) => {
    if (!evaluation) return null;
    const v = view(evaluation);
    return {
      id: v.id,
      status: v.status,
      checklist_version_id: v.checklist_version_id,
      total_original: v.original?.scores.total ?? null,
      total_final: v.final?.scores.total ?? null,
      gross_error: v.final?.scores.gross_error ?? false,
      needs_review: v.needs_review,
      appeals_open: v.appeals.filter((a) => a.status === 'open').length,
      appeals_decided: v.appeals.filter((a) => a.status === 'decided').length,
      error: v.error,
    };
  };

  const app = express();
  app.locals.queue = queue;
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(path.join(ROOT, 'web')));

  const api = express.Router();

  api.get('/health', (req, res) => {
    res.json({
      provider: settings.llmProvider,
      model: configuredModel(settings),
      dataset_configured: Boolean(settings.datasetUrl),
      queue: queue.size(),
    });
  });

  api.post('/datasets/:groupId/fetch', async (req, res) => {
    try {
      const dataset = await fetchDataset(req.params.groupId, { baseUrl: settings.datasetUrl, fetchImpl });
      db.conversations.upsertMany(req.params.groupId, dataset.records);
      res.json({ group: req.params.groupId, imported: dataset.records.length, total: dataset.total });
    } catch (error) {
      throw new HttpError(502, error.message);
    }
  });

  api.post('/conversations/import', (req, res) => {
    let records;
    try {
      records = normalizeImportBody(req.body);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const group = typeof req.query.group === 'string' && req.query.group.trim() ? req.query.group.trim() : 'IMPORT';
    db.conversations.upsertMany(group, records);
    res.json({ group, imported: records.length });
  });

  // Свой диалог текстом «00:12 оператор: текст» — для проверки на собственном примере.
  api.post('/conversations/paste', (req, res) => {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
    let record;
    try {
      record = parsePastedDialog(req.body?.text, { conversationId: `own-${stamp}`, language: req.body?.language || undefined });
      normalizeImportBody([record]);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    db.conversations.upsertMany('OWN', [record]);
    res.status(201).json({ conversation_id: record.conversation_id, group: 'OWN', language: record.language, turns: record.transcript.length });
  });

  api.get('/groups', (req, res) => res.json(db.conversations.groups()));

  api.get('/conversations', (req, res) => {
    const { group, language, channel, checklist } = req.query;
    const rows = db.conversations.list(group || undefined)
      .filter((c) => !language || c.language === language)
      .filter((c) => !channel || c.channel === channel)
      .map((c) => ({
        conversation_id: c.conversation_id,
        group_id: c.group_id,
        channel: c.channel,
        language: c.language,
        turns: c.transcript.length,
        evaluation: summary(db.evaluations.latestFor(c.conversation_id, checklist || undefined)),
      }));
    res.json(rows);
  });

  api.get('/conversations/:id', (req, res) => {
    const conversation = db.conversations.get(req.params.id);
    if (!conversation) throw new HttpError(404, 'Диалог не найден');
    const latest = db.checklists.latest();
    const normalized = normalizeConversation(conversation, { pauseThresholdSec: latest?.config.settings?.pause_threshold_sec });
    res.json({
      conversation: { ...normalized, group_id: conversation.group_id, has_audio: Boolean(conversation.audio_url) },
      evaluations: db.evaluations.listFor(conversation.conversation_id).map(summary),
    });
  });

  api.get('/conversations/:id/audio', async (req, res) => {
    const conversation = db.conversations.get(req.params.id);
    if (!conversation?.audio_url) throw new HttpError(404, 'У диалога нет записи');
    try {
      res.redirect(302, await resolveAudioUrl(conversation.audio_url, { fetchImpl, hostSuffix: settings.audioHostSuffix }));
    } catch (error) {
      throw new HttpError(502, error.message);
    }
  });

  const checklistMeta = (c) => ({
    id: c.id,
    version: c.version,
    name: c.name,
    created_at: c.created_at,
    criteria: c.config.criteria.length,
    total_weight: totalWeight(c.config),
    warnings: checklistWarnings(c.config),
  });

  api.get('/checklists', (req, res) => res.json(db.checklists.list().map(checklistMeta)));

  api.get('/checklists/:versionId', (req, res) => {
    const checklist = db.checklists.get(req.params.versionId);
    if (!checklist) throw new HttpError(404, 'Версия чек-листа не найдена');
    res.json({ ...checklistMeta(checklist), config: checklist.config });
  });

  api.post('/checklists', (req, res) => {
    const name = requireText(req.body?.name, 'Укажите название версии');
    const errors = validateChecklist(req.body?.config);
    if (errors.length) throw new HttpError(400, 'Чек-лист не сохранён: исправьте ошибки', { errors });
    res.status(201).json(checklistMeta(db.checklists.create(name, req.body.config)));
  });

  api.post('/evaluations', async (req, res) => {
    const ids = req.body?.conversation_ids;
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'Выберите хотя бы один диалог');
    const unknown = ids.filter((id) => !db.conversations.get(id));
    if (unknown.length) throw new HttpError(400, `Диалоги не найдены: ${unknown.slice(0, 5).join(', ')}`);
    const version = db.checklists.get(req.body.checklist_version_id);
    if (!version) throw new HttpError(400, 'Версия чек-листа не найдена');

    let llm;
    try {
      llm = await createLlm(settings);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const created = [...new Set(ids)].map((id) => db.evaluations.create({
      conversation_id: id, checklist_version_id: version.id, provider: llm.name, model: llm.model,
    }));
    queue.enqueue(created.map((e) => ({ evaluationId: e.id, llm })));
    res.status(202).json({ evaluations: created.map((e) => ({ id: e.id, conversation_id: e.conversation_id, status: e.status })) });
  });

  api.get('/evaluations/:id', (req, res) => res.json(view(getEvaluation(req.params.id))));

  // «Как надо было ответить»: один запрос к модели по кнопке, ответ сохраняется.
  api.post('/evaluations/:id/coaching', async (req, res) => {
    const evaluation = getEvaluation(req.params.id);
    if (evaluation.status !== 'done' || !evaluation.result) throw new HttpError(400, 'Оценка ещё не готова');
    const current = view(evaluation);
    const row = current.criteria.find((c) => c.id === req.body?.criterion_id);
    if (!row) throw new HttpError(400, 'Неизвестный критерий');
    if (row.type === 'flag') throw new HttpError(400, 'Для грубой ошибки подсказка не составляется: здесь нужен разбор проверяющего');
    const { effective_weight: weight, effective_score: score } = row.final;
    if (weight === null || score >= weight) throw new HttpError(400, 'Критерий выполнен или не применяется: подсказка не нужна');
    const existing = db.coaching.get(evaluation.id, row.id);
    if (existing) return res.json(existing);

    let llm;
    try {
      llm = await createLlm(settings);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const version = db.checklists.get(evaluation.checklist_version_id);
    const conversation = db.conversations.get(evaluation.conversation_id);
    let coach;
    try {
      coach = await coachCriterion({
        llm,
        criterion: version.config.criteria.find((c) => c.id === row.id),
        item: evaluation.result.criteria.find((c) => c.id === row.id),
        normalized: normalizeConversation(conversation, { pauseThresholdSec: version.config.settings?.pause_threshold_sec }),
        kbDocs,
        clientLanguage: evaluation.result.client_language,
      });
    } catch (error) {
      throw new HttpError(502, error.message);
    }
    res.status(201).json(db.coaching.save({ evaluation_id: evaluation.id, criterion_id: row.id, ...coach }));
  });

  api.post('/appeals', (req, res) => {
    const evaluation = getEvaluation(req.body?.evaluation_id);
    if (evaluation.status !== 'done') throw new HttpError(409, 'Оценка ещё не готова');
    const checklist = db.checklists.get(evaluation.checklist_version_id).config;
    if (!checklist.criteria.some((c) => c.id === req.body.criterion_id)) throw new HttpError(400, 'В этой версии чек-листа нет такого критерия');
    const comment = requireText(req.body.comment, 'Опишите, с чем вы не согласны');
    if (db.appeals.forEvaluation(evaluation.id).some((a) => a.criterion_id === req.body.criterion_id && a.status === 'open')) {
      throw new HttpError(409, 'По этому критерию уже есть открытая апелляция');
    }
    res.status(201).json(db.appeals.create({ evaluation_id: evaluation.id, criterion_id: req.body.criterion_id, comment }));
  });

  api.get('/appeals', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(db.appeals.list(status).map((appeal) => {
      const evaluation = db.evaluations.get(appeal.evaluation_id);
      const v = view(evaluation);
      const criterion = v.criteria.find((c) => c.id === appeal.criterion_id);
      const conversation = normalizeConversation(db.conversations.get(evaluation.conversation_id));
      const anchors = [...criterion.evidence.map((e) => e.msg_id), ...criterion.expected_at];
      return {
        ...appeal,
        conversation_id: evaluation.conversation_id,
        channel: conversation.channel,
        language: conversation.language,
        checklist_version_id: evaluation.checklist_version_id,
        total_final: v.final.scores.total,
        criterion,
        fragment: fragmentFor(conversation.messages, anchors),
      };
    }));
  });

  api.post('/appeals/:id/decision', (req, res) => {
    const appeal = db.appeals.get(req.params.id);
    if (!appeal) throw new HttpError(404, 'Апелляция не найдена');
    if (appeal.status !== 'open') throw new HttpError(409, 'Решение по апелляции уже принято');
    const { action } = req.body ?? {};
    if (action !== 'confirm' && action !== 'change') throw new HttpError(400, 'Выберите «Подтвердить» или «Изменить»');
    const reason = requireText(req.body.reason, 'Укажите причину решения');
    const evaluation = db.evaluations.get(appeal.evaluation_id);
    const criterion = db.checklists.get(evaluation.checklist_version_id).config.criteria.find((c) => c.id === appeal.criterion_id);
    let newValue = null;
    if (action === 'change') {
      newValue = String(req.body.new_value ?? '');
      if (!decisionValues(criterion).includes(newValue)) {
        throw new HttpError(400, `Недопустимое значение: можно ${decisionValues(criterion).join(', ')}`);
      }
    }
    if (db.appeals.decide(appeal.id, { action, new_value: newValue, reason }) === 0) throw new HttpError(409, 'Решение по апелляции уже принято');
    res.json({ appeal: db.appeals.get(appeal.id), evaluation: view(evaluation) });
  });

  api.get('/overview', (req, res) => {
    try {
      res.json(collectOverview(db, { versionId: req.query.version, groupId: req.query.group, allowMock: req.query.allow_mock === '1' }));
    } catch (error) {
      if (/не найдена/.test(error.message)) throw new HttpError(404, error.message);
      throw error;
    }
  });

  // Ручная разметка эталона и точность модели против неё.
  const labelsDir = () => {
    if (!settings.labelsDir) throw new HttpError(500, 'Не задан каталог разметки');
    return settings.labelsDir;
  };

  api.get('/labels', (req, res) => res.json({ labels: readLabels(labelsDir()) }));

  api.put('/labels/:conversationId', (req, res) => {
    const conversation = db.conversations.get(req.params.conversationId);
    if (!conversation) throw new HttpError(404, 'Диалог не найден');
    const labeler = requireText(req.body?.labeler, 'Укажите, кто размечает');
    const version = db.checklists.get(req.body.checklist_version_id);
    if (!version) throw new HttpError(400, 'Неизвестная версия чек-листа');
    const errors = validateLabel(req.body, version.config);
    if (errors.length) throw new HttpError(400, `Разметка неполная: ${errors.join('; ')}`, { errors });
    try {
      res.json(saveLabel(labelsDir(), labeler, conversation.conversation_id, { checklist_version_id: version.id, criteria: req.body.criteria }));
    } catch (error) {
      if (/имя/.test(error.message)) throw new HttpError(400, error.message);
      throw error;
    }
  });

  api.get('/accuracy', (req, res) => {
    let report;
    try {
      report = collectAccuracy(db, {
        versionId: req.query.version,
        groupId: req.query.group,
        labels: readLabels(labelsDir()),
        tuningIds: settings.tuningIds ?? [],
        allowMock: req.query.allow_mock === '1',
      });
    } catch (error) {
      if (/не найдена/.test(error.message)) throw new HttpError(404, error.message);
      throw error;
    }
    const { checklist, ...body } = report;
    res.json(body);
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Нет такого метода API' }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...error.extra });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Тело запроса — некорректный JSON' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Файл слишком большой' });
    if (/UNIQUE/.test(error.message)) return res.status(409).json({ error: 'Такая запись уже есть' });
    console.error(error);
    return res.status(500).json({ error: error.message });
  });

  return app;
}
