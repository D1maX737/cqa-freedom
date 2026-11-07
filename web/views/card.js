import { api } from '../api.js';
import {
  CHANNEL_NAMES, ROLE_NAMES, STATUS_NAMES, answerText, answerTone, bindDecisionForms, clock, decisionForm,
  decisionTriple, errorPanel, fmt, html, mountView, toast,
} from './ui.js';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Обратные ссылки: какие критерии опираются на реплику и какие ждали в ней действия. */
function citationMap(evaluation) {
  const map = new Map();
  const add = (msgId, entry) => map.set(msgId, [...(map.get(msgId) ?? []), entry]);
  for (const c of evaluation?.criteria ?? []) {
    for (const e of c.evidence) add(e.msg_id, { id: c.id, kind: c.type === 'flag' ? 'flag' : 'evidence', title: c.title });
    for (const id of c.expected_at) add(id, { id: c.id, kind: 'expected', title: c.title });
  }
  return map;
}

function messageRow(m, cites, isVoice) {
  const time = isVoice ? clock(m.t_sec) : m.timestamp;
  return html`<article class="msg msg--${m.speaker}" id="${m.id}" tabindex="-1">
    <div class="msg__cites">
      ${(cites ?? []).map((c) => html`<a class="cite cite--${c.kind}" href="#crit-${c.id}" data-crit="${c.id}"
        title="${c.kind === 'expected' ? 'Здесь ожидалось действие' : 'Доказательство'}: ${c.title}">${c.id}</a>`)}
    </div>
    <div class="msg__body">
      <div class="msg__meta">
        <span class="msg__role">${ROLE_NAMES[m.speaker] ?? m.speaker}</span>
        <time title="${m.timestamp}">${time}</time>
        <span class="msg__id">${m.id}</span>
        ${isVoice && m.audio_sec !== null ? html`<button type="button" class="msg__play" data-seek="${m.audio_sec}"
          aria-label="Слушать запись с ${clock(m.audio_sec)}">слушать с ${clock(m.audio_sec)}</button>` : ''}
      </div>
      <p class="msg__text">${m.text}</p>
    </div>
  </article>`;
}

function weightLine(c) {
  if (c.type === 'flag') return html`<span>не влияет на итог</span>`;
  const o = c.original;
  if (!o.applicable) return html`<span>вес ${c.weight}, исключён из расчёта</span>`;
  return html`<span>${fmt(o.score)} из ${c.weight} балл.</span>
    <span>вес ${c.weight}${o.effective_weight !== null && o.effective_weight !== c.weight ? `, после перераспределения ${fmt(o.effective_weight)}` : ''}</span>`;
}

function evidenceLinks(c, messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const parts = [];
  if (c.evidence.length) {
    parts.push(html`<div class="links"><span class="links__label">${c.type === 'flag' ? 'Где найдено' : 'Доказательство'}</span>
      ${c.evidence.map((e) => html`<a class="quote ${e.verified === false ? 'quote--unverified' : ''}" href="#${e.msg_id}" data-msg="${e.msg_id}">
        <q>${e.quote}</q><span class="quote__ref">${ROLE_NAMES[byId.get(e.msg_id)?.speaker] ?? ''}, ${e.msg_id}</span></a>`)}
    </div>`);
  }
  if (c.expected_at.length && c.original?.answer !== 'na') {
    parts.push(html`<div class="links"><span class="links__label">Где ожидалось</span>
      ${c.expected_at.map((id) => html`<a class="where" href="#${id}" data-msg="${id}" data-kind="expected">
        ${ROLE_NAMES[byId.get(id)?.speaker] ?? ''}, ${id}: «${(byId.get(id)?.text ?? '').slice(0, 70)}${(byId.get(id)?.text.length ?? 0) > 70 ? '…' : ''}»</a>`)}
    </div>`);
  }
  if (c.original?.answer === 'na' && c.na_reason) {
    parts.push(html`<p class="na-reason"><span class="links__label">Почему N/A</span>${c.na_reason}</p>`);
  }
  return parts;
}

function appealBlock(c, evaluation, role) {
  const { appeal } = c;
  if (appeal?.status === 'decided') return decisionTriple(c, appeal);
  if (appeal?.status === 'open') {
    return html`<div class="appeal">
      <p class="appeal__comment"><span class="links__label">Апелляция</span>${appeal.comment}</p>
      ${role === 'reviewer' ? decisionForm(c, appeal) : html`<p class="muted">Ждёт решения проверяющего.</p>`}
    </div>`;
  }
  if (role !== 'user' || evaluation.status !== 'done') return '';
  return html`<details class="appeal-new">
    <summary class="btn btn--ghost btn--small">Оспорить</summary>
    <form class="appeal-form" data-criterion="${c.id}">
      <label class="field">С чем вы не согласны
        <textarea name="comment" rows="2" required placeholder="Например: оператор представился в реплике m7"></textarea>
      </label>
      <button class="btn btn--primary" type="submit">Отправить апелляцию</button>
    </form>
  </details>`;
}

function criterionBlock(c, evaluation, messages, role) {
  const answer = c.final?.answer ?? null;
  const tone = answerTone(answer, c);
  return html`<section class="crit crit--${tone}" id="crit-${c.id}" tabindex="-1">
    <header class="crit__head">
      <span class="crit__id">${c.id}</span>
      <h4 class="crit__title">${c.title}</h4>
      <span class="answer answer--${tone}">${answerText(answer, c)}</span>
    </header>
    <p class="crit__nums">${weightLine(c)}${c.confidence !== null && c.type !== 'flag' ? html`<span>уверенность ${Math.round(c.confidence * 100)}%</span>` : ''}</p>
    ${c.explanation ? html`<p class="crit__why">${c.explanation}</p>` : ''}
    ${evidenceLinks(c, messages)}
    ${c.needs_review ? html`<p class="review-note">Требует проверки человеком: ${c.review_reasons.join('; ') || 'модель не дала корректного ответа'}</p>` : ''}
    ${appealBlock(c, evaluation, role)}
  </section>`;
}

function scoreHead(evaluation) {
  const { original, final } = evaluation;
  const sections = final.scores.sections.filter((s) => s.applicable_weight > 0);
  return html`<div class="score">
    <div class="score__totals">
      <div class="score__final"><span class="score__label">Финальный итог</span><span class="score__value">${fmt(final.scores.total)}</span></div>
      <div class="score__orig"><span class="score__label">Исходный, до апелляций</span><span>${fmt(original.scores.total)}</span></div>
    </div>
    ${final.scores.gross_error ? html`<p class="gross-flag">Отмечена грубая ошибка: на итог не влияет, учитывается отдельно</p>` : ''}
    ${final.scores.incomplete ? html`<p class="review-note">Не все критерии оценены: итог посчитан по оценённым</p>` : ''}
    <dl class="sections">
      ${sections.map((s) => html`<div class="sections__row">
        <dt>${s.title}</dt>
        <dd><span class="bar" style="--fill:${s.total ?? 0}%"></span><span class="sections__num">${fmt(s.total)}</span></dd>
      </div>`)}
    </dl>
  </div>`;
}

function resultPanel(evaluation, data, role, versions) {
  const evaluations = data.evaluations;
  const picker = html`<div class="result__controls">
    ${evaluations.length ? html`<label class="field field--inline">Оценка
      <select data-select="evaluation">
        ${evaluations.map((e) => html`<option value="${e.id}" ${e.id === evaluation?.id ? 'selected' : ''}>
          ${e.checklist_version_id}, ${STATUS_NAMES[e.status]}${e.total_final !== null ? `, итог ${fmt(e.total_final)}` : ''}</option>`)}
      </select></label>` : ''}
    <form class="reeval" data-form="reevaluate">
      <label class="field field--inline">Чек-лист
        <select name="version">${versions.map((v) => html`<option value="${v.id}">${v.id} — ${v.name}</option>`)}</select>
      </label>
      <button class="btn" type="submit">${evaluations.length ? 'Оценить заново' : 'Оценить'}</button>
    </form>
  </div>`;

  if (!evaluation) return html`${picker}<p class="empty">Диалог ещё не оценивался.</p>`;
  if (evaluation.status === 'queued' || evaluation.status === 'running') {
    return html`${picker}<p class="empty" aria-live="polite">Оценка ${STATUS_NAMES[evaluation.status]}…</p>`;
  }
  if (evaluation.status === 'failed') return html`${picker}<div class="panel panel--error"><p>Оценка не удалась: ${evaluation.error}</p></div>`;

  const groups = evaluation.sections.map((s) => ({ ...s, criteria: evaluation.criteria.filter((c) => c.section === s.id) }))
    .filter((s) => s.criteria.length);
  return html`${picker}
    ${scoreHead(evaluation)}
    <p class="meta-line">${evaluation.intent ? html`Запрос: ${evaluation.intent.replace(/[.\s]+$/, '')}. ` : ''}Язык клиента: ${evaluation.client_language ?? '—'}.
      Модель: ${evaluation.model}${evaluation.cost_usd ? `, $${evaluation.cost_usd.toFixed(4)}` : ''}${evaluation.attempts > 1 ? `, попыток: ${evaluation.attempts}` : ''}.</p>
    ${groups.map((s) => html`<section class="crit-group"><h3>${s.title}</h3>
      ${s.criteria.map((c) => criterionBlock(c, evaluation, data.conversation.messages, role))}</section>`)}`;
}

function seek(audio, sec, { play }) {
  const go = () => {
    audio.currentTime = Math.max(0, sec - 2);
    if (play) audio.play().catch(() => {});
  };
  if (audio.readyState >= 1) go();
  else {
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', go, { once: true });
    audio.load();
  }
}

function flash(node, className) {
  node.classList.remove('is-target', 'is-expected');
  void node.offsetWidth;
  node.classList.add(className);
  node.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  node.focus({ preventScroll: true });
  setTimeout(() => node.classList.remove(className), 2600);
}

export async function render(container, state) {
  const { id } = state.route;
  let data;
  let evaluation = null;
  let versions;
  try {
    [data, versions] = await Promise.all([api.conversation(id), api.checklists()]);
    const chosen = state.route.e ?? data.evaluations.find((e) => e.status === 'done')?.id ?? data.evaluations[0]?.id;
    if (chosen) evaluation = await api.evaluation(chosen);
  } catch (error) {
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }

  const conv = data.conversation;
  const isVoice = conv.channel === 'voice call';
  const cites = citationMap(evaluation?.status === 'done' ? evaluation : null);

  const root = mountView(container, html`
    <section class="page-head page-head--card">
      <a href="?view=list" data-nav class="back">К списку диалогов</a>
      <h1>${conv.conversation_id}</h1>
      <p class="chips"><span class="chip">${CHANNEL_NAMES[conv.channel] ?? conv.channel}</span><span class="chip">${conv.language}</span>
        <span class="chip">${conv.messages.length} реплик</span><span class="chip">набор ${conv.group_id}</span></p>
    </section>
    <div class="card">
      <section class="transcript" aria-label="Транскрипт">
        ${isVoice && conv.has_audio ? html`<div class="player">
          <audio controls preload="none" src="${api.audioUrl(conv.conversation_id)}"></audio>
          <p class="player__note" data-player-note>Позиция в записи считается от старта записи без пауз. Воспроизведение начинается на 2 секунды раньше реплики.</p>
        </div>` : ''}
        <div class="transcript__list">${conv.messages.map((m) => messageRow(m, cites.get(m.id), isVoice))}</div>
      </section>
      <section class="result" aria-label="Результат оценки">${resultPanel(evaluation, data, state.role, versions)}</section>
    </div>`);

  const audio = root.querySelector('audio');
  const byId = new Map(conv.messages.map((m) => [m.id, m]));

  const focusMessage = (msgId, kind) => {
    const node = root.querySelector(`#${CSS.escape(msgId)}`);
    if (!node) return;
    history.replaceState(null, '', `${location.search}#${msgId}`);
    flash(node, kind === 'expected' ? 'is-expected' : 'is-target');
    const sec = byId.get(msgId)?.audio_sec;
    if (audio && sec !== null && sec !== undefined) {
      seek(audio, sec, { play: false });
      root.querySelector('[data-player-note]').textContent = `Запись перемотана к ${clock(Math.max(0, sec - 2))}: нажмите воспроизведение.`;
    }
  };

  root.addEventListener('click', (event) => {
    const msgLink = event.target.closest('[data-msg]');
    if (msgLink) {
      event.preventDefault();
      focusMessage(msgLink.dataset.msg, msgLink.dataset.kind);
      return;
    }
    const critLink = event.target.closest('[data-crit]');
    if (critLink) {
      event.preventDefault();
      const node = root.querySelector(`#crit-${CSS.escape(critLink.dataset.crit)}`);
      if (node) flash(node, 'is-target');
      return;
    }
    const play = event.target.closest('[data-seek]');
    if (play && audio) seek(audio, Number(play.dataset.seek), { play: true });
  });

  root.querySelector('[data-select=evaluation]')?.addEventListener('change', (event) => {
    state.navigate(`?view=card&id=${encodeURIComponent(id)}&e=${event.target.value}`, { replace: true });
  });

  root.querySelector('[data-form=reevaluate]').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { evaluations } = await api.evaluate([id], new FormData(event.target).get('version'));
      toast('Диалог отправлен на оценку');
      state.navigate(`?view=card&id=${encodeURIComponent(id)}&e=${evaluations[0].id}`, { replace: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('form.appeal-form');
    if (!form) return;
    event.preventDefault();
    try {
      await api.createAppeal(evaluation.id, form.dataset.criterion, new FormData(form).get('comment'));
      toast('Апелляция отправлена проверяющему');
      state.refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  bindDecisionForms(root, api, () => state.refresh());

  if (location.hash.startsWith('#m')) focusMessage(location.hash.slice(1));
  if (evaluation && (evaluation.status === 'queued' || evaluation.status === 'running')) {
    state.schedule(() => render(container, state), 1500);
  }
}
