import { allowedAnswers, flagTypes } from '../checklist.js';

/** Схема общая для всех критериев: что допустимо для конкретного критерия, проверяет validate.js. */
export function buildResponseSchema(checklist) {
  const scored = checklist.criteria.filter((c) => c.type !== 'flag');
  const answers = [...new Set(scored.flatMap(allowedAnswers))];
  const types = flagTypes(checklist).map((t) => t.id);
  const object = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

  return object({
    client_language: { type: 'string', enum: ['RU', 'KZ', 'EN', 'mixed'] },
    intent: { type: 'string' },
    criteria: {
      type: 'array',
      items: object({
        id: { type: 'string', enum: scored.map((c) => c.id) },
        answer: { type: 'string', enum: answers },
        explanation: { type: 'string' },
        evidence: { type: 'array', items: object({ msg_id: { type: 'string' }, quote: { type: 'string' } }) },
        expected_at: { type: 'array', items: { type: 'string' } },
        na_reason: { type: ['string', 'null'] },
        confidence: { type: 'number' },
      }),
    },
    gross_errors: {
      type: 'array',
      items: object({
        type: types.length ? { type: 'string', enum: types } : { type: 'string' },
        msg_id: { type: 'string' },
        quote: { type: 'string' },
        explanation: { type: 'string' },
      }),
    },
  });
}
