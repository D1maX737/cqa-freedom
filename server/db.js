import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  channel         TEXT NOT NULL,
  language        TEXT NOT NULL,
  audio_url       TEXT,
  transcript_json TEXT NOT NULL,
  fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_group ON conversations(group_id);

CREATE TABLE IF NOT EXISTS checklist_versions (
  id          TEXT PRIMARY KEY,
  version     INTEGER NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS checklist_versions_no_update BEFORE UPDATE ON checklist_versions
BEGIN SELECT RAISE(ABORT, 'версия чек-листа неизменяема'); END;
CREATE TRIGGER IF NOT EXISTS checklist_versions_no_delete BEFORE DELETE ON checklist_versions
BEGIN SELECT RAISE(ABORT, 'версия чек-листа неизменяема'); END;

CREATE TABLE IF NOT EXISTS evaluations (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL REFERENCES conversations(conversation_id),
  checklist_version_id TEXT NOT NULL REFERENCES checklist_versions(id),
  status               TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  attempts             INTEGER NOT NULL DEFAULT 0,
  result_json          TEXT,
  validation_json      TEXT,
  raw_responses_json   TEXT,
  needs_review         INTEGER NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,
  error                TEXT,
  created_at           TEXT NOT NULL,
  finished_at          TEXT
);
CREATE INDEX IF NOT EXISTS evaluations_conversation ON evaluations(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id            TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
  criterion_id  TEXT NOT NULL,
  comment       TEXT NOT NULL,
  status        TEXT NOT NULL,
  action        TEXT,
  new_value     TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS appeals_one_open ON appeals(evaluation_id, criterion_id) WHERE status = 'open';
`;

const now = () => new Date().toISOString();

const parseConversation = (row) => row && ({
  conversation_id: row.conversation_id,
  group_id: row.group_id,
  channel: row.channel,
  language: row.language,
  audio_url: row.audio_url,
  transcript: JSON.parse(row.transcript_json),
  fetched_at: row.fetched_at,
});

const parseChecklist = (row) => row && ({
  id: row.id,
  version: row.version,
  name: row.name,
  config: JSON.parse(row.config_json),
  created_at: row.created_at,
});

const parseEvaluation = (row) => row && ({
  id: row.id,
  conversation_id: row.conversation_id,
  checklist_version_id: row.checklist_version_id,
  status: row.status,
  provider: row.provider,
  model: row.model,
  attempts: row.attempts,
  result: row.result_json ? JSON.parse(row.result_json) : null,
  validation: row.validation_json ? JSON.parse(row.validation_json) : [],
  raw_responses: row.raw_responses_json ? JSON.parse(row.raw_responses_json) : [],
  needs_review: Boolean(row.needs_review),
  input_tokens: row.input_tokens,
  output_tokens: row.output_tokens,
  cost_usd: row.cost_usd,
  error: row.error,
  created_at: row.created_at,
  finished_at: row.finished_at,
});

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);

  const upsertConversation = raw.prepare(`
    INSERT INTO conversations (conversation_id, group_id, channel, language, audio_url, transcript_json, fetched_at)
    VALUES (@conversation_id, @group_id, @channel, @language, @audio_url, @transcript_json, @fetched_at)
    ON CONFLICT(conversation_id) DO UPDATE SET
      group_id = excluded.group_id, channel = excluded.channel, language = excluded.language,
      audio_url = excluded.audio_url, transcript_json = excluded.transcript_json, fetched_at = excluded.fetched_at
  `);

  const conversations = {
    upsertMany: raw.transaction((groupId, records) => {
      const fetchedAt = now();
      for (const r of records) {
        upsertConversation.run({
          conversation_id: r.conversation_id,
          group_id: groupId,
          channel: r.channel,
          language: r.language,
          audio_url: r.audio_url ?? null,
          transcript_json: JSON.stringify(r.transcript),
          fetched_at: fetchedAt,
        });
      }
      return records.length;
    }),
    get: (id) => parseConversation(raw.prepare('SELECT * FROM conversations WHERE conversation_id = ?').get(id)),
    list: (groupId) => {
      const rows = groupId
        ? raw.prepare('SELECT * FROM conversations WHERE group_id = ? ORDER BY conversation_id').all(groupId)
        : raw.prepare('SELECT * FROM conversations ORDER BY group_id, conversation_id').all();
      return rows.map(parseConversation);
    },
    groups: () => raw.prepare('SELECT group_id, COUNT(*) AS total FROM conversations GROUP BY group_id ORDER BY group_id').all(),
  };

  const checklists = {
    create: raw.transaction((name, cfg) => {
      const { next } = raw.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM checklist_versions').get();
      const id = `v${next}`;
      raw.prepare('INSERT INTO checklist_versions (id, version, name, config_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, next, name, JSON.stringify(cfg), now());
      return parseChecklist(raw.prepare('SELECT * FROM checklist_versions WHERE id = ?').get(id));
    }),
    get: (id) => parseChecklist(raw.prepare('SELECT * FROM checklist_versions WHERE id = ?').get(id)),
    list: () => raw.prepare('SELECT * FROM checklist_versions ORDER BY version').all().map(parseChecklist),
    latest: () => parseChecklist(raw.prepare('SELECT * FROM checklist_versions ORDER BY version DESC LIMIT 1').get()),
  };

  const evaluations = {
    create: ({ conversation_id, checklist_version_id, provider, model }) => {
      const id = randomUUID();
      raw.prepare(`INSERT INTO evaluations (id, conversation_id, checklist_version_id, status, provider, model, created_at)
                   VALUES (?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, conversation_id, checklist_version_id, provider, model, now());
      return evaluations.get(id);
    },
    get: (id) => parseEvaluation(raw.prepare('SELECT * FROM evaluations WHERE id = ?').get(id)),
    latestFor: (conversationId, checklistVersionId) => parseEvaluation(checklistVersionId
      ? raw.prepare(`SELECT * FROM evaluations WHERE conversation_id = ? AND checklist_version_id = ?
                     ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(conversationId, checklistVersionId)
      : raw.prepare('SELECT * FROM evaluations WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversationId)),
    listFor: (conversationId) => raw.prepare('SELECT * FROM evaluations WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(conversationId).map(parseEvaluation),
    markRunning: (id) => raw.prepare("UPDATE evaluations SET status = 'running' WHERE id = ?").run(id),
    finish: (id, r) => raw.prepare(`UPDATE evaluations SET status = 'done', model = @model, attempts = @attempts, result_json = @result,
        validation_json = @validation, raw_responses_json = @raw, needs_review = @needs_review, input_tokens = @input_tokens,
        output_tokens = @output_tokens, cost_usd = @cost_usd, finished_at = @finished_at WHERE id = @id`)
      .run({
        id,
        model: r.model,
        attempts: r.attempts,
        result: JSON.stringify(r.result),
        validation: JSON.stringify(r.validation),
        raw: JSON.stringify(r.raw_responses),
        needs_review: r.needs_review ? 1 : 0,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cost_usd: r.cost_usd,
        finished_at: now(),
      }),
    fail: (id, message, partial = {}) => raw.prepare(`UPDATE evaluations SET status = 'failed', error = ?, raw_responses_json = ?,
        input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = ? WHERE id = ?`)
      .run(message, JSON.stringify(partial.raw_responses ?? []), partial.input_tokens ?? 0, partial.output_tokens ?? 0,
        partial.cost_usd ?? 0, now(), id),
    failInterrupted: () => raw.prepare(`UPDATE evaluations SET status = 'failed', error = 'Оценка прервана перезапуском сервера',
        finished_at = ? WHERE status IN ('queued', 'running')`).run(now()),
  };

  const appeals = {
    create: ({ evaluation_id, criterion_id, comment }) => {
      const id = randomUUID();
      raw.prepare(`INSERT INTO appeals (id, evaluation_id, criterion_id, comment, status, created_at)
                   VALUES (?, ?, ?, ?, 'open', ?)`).run(id, evaluation_id, criterion_id, comment, now());
      return appeals.get(id);
    },
    get: (id) => raw.prepare('SELECT * FROM appeals WHERE id = ?').get(id),
    list: (status) => (status
      ? raw.prepare('SELECT * FROM appeals WHERE status = ? ORDER BY created_at, rowid').all(status)
      : raw.prepare('SELECT * FROM appeals ORDER BY created_at, rowid').all()),
    forEvaluation: (evaluationId) => raw.prepare('SELECT * FROM appeals WHERE evaluation_id = ? ORDER BY created_at, rowid').all(evaluationId),
    decide: (id, { action, new_value, reason }) => raw.prepare(`UPDATE appeals SET status = 'decided', action = ?, new_value = ?,
        reason = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
      .run(action, new_value ?? null, reason, now(), id).changes,
  };

  return { raw, conversations, checklists, evaluations, appeals, close: () => raw.close() };
}
