import { api } from '../api.js';
import {
  CHANNEL_NAMES, ROLE_NAMES, STATUS_NAMES, answerText, answerTone, bindDecisionForms, clock, decisionForm,
  decisionTriple, errorPanel, fmt, html, mountView, toast,
} from './ui.js';

const LANGUAGE_NAMES = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const demoNote = html`<p class="demo-note"><strong>Заглушка · тестовый режим</strong><br>
  Баллы и ссылки на реплики подставлены для проверки интерфейса без обращения к ИИ.</p>`;

/** Обратные ссылки: какие критерии опираются на реплику и какие ждали в ней действия. */
function citationMap(evaluation, changes) {
  const map = new Map();
  if (evaluation?.provider === 'mock') return map;
  const add = (msgId, entry) => map.set(msgId, [...(map.get(msgId) ?? []), entry]);
  for (const c of evaluation?.criteria ?? []) {
    if (changes.has(c.id)) continue;
    for (const e of c.evidence.filter((entry) => entry.verified !== false)) {
      add(e.msg_id, { id: c.id, kind: c.type === 'flag' ? 'flag' : 'evidence', title: c.title });
    }
    for (const id of c.expected_at) add(id, { id: c.id, kind: 'expected', title: c.title });
  }
  return map;
}

const messageTime = (message, isVoice) => isVoice ? clock(message.t_sec) : message.timestamp;

export function messageRow(m, cites, isVoice) {
  return html`<article class="msg msg--${m.speaker}" id="${m.id}" tabindex="-1">
    <div class="msg__cites">
      ${(cites ?? []).map((c) => html`<a class="cite cite--${c.kind}" href="#crit-${c.id}" data-crit="${c.id}"
        title="${c.kind === 'expected' ? 'Здесь ожидалось действие' : 'Доказательство'}: ${c.title}">${c.id}</a>`)}
    </div>
    <div class="msg__body">
      <div class="msg__meta">
        <span class="msg__role">${ROLE_NAMES[m.speaker] ?? m.speaker}</span>
        <time title="${m.timestamp}">${messageTime(m, isVoice)}</time>
        <span class="msg__id">${m.id}</span>
        ${isVoice && m.audio_sec !== null ? html`<button type="button" class="msg__play" data-seek="${m.audio_sec}"
          aria-label="Слушать запись с ${clock(m.audio_sec)}">слушать с ${clock(m.audio_sec)}</button>` : ''}
      </div>
      <p class="msg__text">${m.text}</p>
    </div>
  </article>`;
}

function weightLine(c) {
  if (c.type === 'flag') return html`<span>Учитывается отдельно от балла</span>`;
  const o = c.final;
  if (!o.applicable) return html`<span>Критерий исключён из расчёта</span>`;
  if (o.pending) return html`<span>Баллы ожидают проверки</span>`;
  // Задание требует показывать вес исходный и после перераспределения N/A.
  const redistributed = o.effective_weight !== null && o.effective_weight !== c.weight;
  return html`<span>Баллы по критерию <strong>${fmt(o.score)} из ${fmt(c.weight)}</strong></span>
    ${redistributed ? html`<span>Вес ${fmt(c.weight)}, после перераспределения ${fmt(o.effective_weight)}</span>` : ''}`;
}

function evidenceLinks(c, { byId, isVoice, demo }) {
  const ref = (m) => `${ROLE_NAMES[m.speaker] ?? m.speaker} · ${messageTime(m, isVoice)} · ${m.id}`;
  const links = c.evidence.filter((e) => byId.has(e.msg_id));
  const expected = c.original?.answer === 'na' ? [] : c.expected_at.filter((id) => byId.has(id));
  return html`
    ${links.length ? html`<div class="links"><span class="links__label">${demo ? 'Пример ссылки на реплику' : 'Реплики в обосновании'}</span>
      ${links.map((e) => html`<a class="quote ${e.verified === false ? 'quote--unverified' : ''}" href="#${e.msg_id}" data-msg="${e.msg_id}">
        ${e.verified === false ? 'Цитата требует сверки с репликой' : html`<q>${e.quote}</q>`}
        <span class="quote__ref">Перейти к реплике · ${ref(byId.get(e.msg_id))}</span></a>`)}
    </div>` : ''}
    ${expected.length ? html`<div class="links"><span class="links__label">${demo ? 'Пример перехода к реплике' : 'Где проверить пропуск действия'}</span>
      ${expected.map((id) => html`<a class="where" href="#${id}" data-msg="${id}" data-kind="${demo ? 'demo' : 'expected'}">
        <span class="quote__ref">Перейти к реплике · ${ref(byId.get(id))}</span></a>`)}
    </div>` : ''}`;
}

function originalExplanation(c, context) {
  const na = c.original?.answer === 'na';
  const reason = na ? c.na_reason || c.explanation : c.explanation;
  return html`
    ${!context.demo && reason ? html`<p class="crit__why">
      <strong>${na ? 'Почему критерий не применяется' : 'Обоснование'}</strong>${reason}</p>` : ''}
    ${evidenceLinks(c, context)}
    ${c.needs_review ? html`<p class="review-note">Обоснование требует проверки.</p>` : ''}`;
}

function appealBlock(c, evaluation, role) {
  const { appeal } = c;
  // Задание: в карточке видны исходная оценка, решение и финальная.
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

/** Решения проверяющего по другим диалогам, которые модель видела в промпте для этого критерия. */
function precedentNote(c, evaluation, demo) {
  const used = demo ? [] : (evaluation.precedents ?? []).filter((p) => p.criterion_id === c.id);
  if (!used.length) return '';
  return html`<p class="precedent-note">Учтено решение проверяющего по апелляции в
    ${used.map((p, i) => html`${i ? ', ' : ''}<a href="?view=card&id=${encodeURIComponent(p.conversation_id)}" data-nav>${p.conversation_id}</a>`)}</p>`;
}

function coachView(x) {
  return html`<div class="coach__body">
    <span class="links__label">Как можно было ответить${x.msg_id ? ` на месте ${x.msg_id}` : ''}</span>
    <blockquote class="coach__reply">${x.suggestion}</blockquote>
    ${x.why ? html`<p class="coach__why">${x.why}</p>` : ''}
    <p class="coach__note">Подсказка ИИ по фактам диалога и базе знаний. Проверьте перед использованием.</p>
  </div>`;
}

/** «Как надо было ответить» — только у критериев, где потеряны баллы. */
function coachBlock(c, evaluation) {
  if (c.type === 'flag' || !c.final) return '';
  const { effective_weight: weight, effective_score: score } = c.final;
  if (weight === null || score >= weight) return '';
  const saved = (evaluation.coaching ?? []).find((x) => x.criterion_id === c.id);
  return html`<div class="coach" data-coach="${c.id}">${saved ? coachView(saved)
    : html`<button type="button" class="btn btn--small" data-coach-btn="${c.id}">Как надо было ответить</button>`}</div>`;
}

function criterionBlock(c, evaluation, context) {
  const { demo, role, changes } = context;
  const answer = c.final?.answer ?? null;
  const tone = demo ? 'none' : answerTone(answer, c);
  const outcomes = { yes: 'Выполнено', no: 'Не выполнено' };
  const outcome = (c.type === 'binary' ? outcomes[answer] : null) ?? answerText(answer, c);
  const scaleStep = c.scale_labels?.[answer];
  const rule = answer === 'na' ? c.na_condition : scaleStep ?? c.definition;
  const change = changes.get(c.id);
  return html`<section class="crit crit--${tone}" id="crit-${c.id}" tabindex="-1">
    <header class="crit__head">
      <span class="crit__id">${c.id}</span>
      <h4 class="crit__title">${c.title}</h4>
      <span class="answer answer--${tone}">${demo ? 'Пример · ' : ''}${scaleStep ? 'Уровень ' : ''}${outcome}</span>
    </header>
    <p class="crit__nums">${weightLine(c)}</p>
    ${precedentNote(c, evaluation, demo)}
    ${rule ? html`<details class="crit__rule" ${['bad', 'partial', 'na'].includes(tone) ? 'open' : ''}>
      <summary>${scaleStep ? 'Что означает уровень по шкале' : 'Условие чек-листа'}</summary>
      <p>${rule}</p>
    </details>` : ''}
    ${change ? html`<details class="crit__history">
        <summary>Первоначальное обоснование</summary>
        ${originalExplanation(c, context)}
      </details>` : originalExplanation(c, context)}
    ${coachBlock(c, evaluation)}
    ${appealBlock(c, evaluation, role)}
  </section>`;
}

/** Все критерии одной строкой над перепиской: статус и реплика, на которую он опирается. */
function critPath(evaluation, demo) {
  if (demo) return '';
  const label = (c, answer) => {
    if (answer === null || answer === undefined) return 'нет ответа';
    if (c.type === 'flag') return answer === 'yes' ? 'есть' : 'нет';
    if (answer === 'na') return 'N/A';
    if (c.type === 'scale') return `${answer} из ${Math.max(...c.scale)}`;
    return answer === 'yes' ? 'да' : 'нет';
  };
  return html`<nav class="crit-path" aria-label="Критерии чек-листа">
    ${evaluation.criteria.map((c) => {
      const answer = c.final?.answer ?? null;
      const tone = answerTone(answer, c);
      const missed = tone === 'bad' || tone === 'partial';
      const msg = missed ? c.expected_at[0] ?? c.evidence[0]?.msg_id : c.evidence[0]?.msg_id;
      const kind = missed && c.expected_at[0] && c.type !== 'flag' ? 'expected' : 'evidence';
      return html`<a class="crit-path__item crit-path__item--${tone}" href="#crit-${c.id}" data-path="${c.id}"
        ${msg ? html`data-path-msg="${msg}" data-path-kind="${kind}"` : ''} title="${c.id} ${c.title}: ${answerText(answer, c)}${msg ? `, реплика ${msg}` : ''}">
        <span class="crit-path__id">${c.id}</span>${label(c, answer)}${missed && msg ? html`<span class="crit-path__msg">${msg}</span>` : ''}</a>`;
    })}
  </nav>`;
}

function scoreHead(evaluation) {
  const { scores } = evaluation.final;
  const demo = evaluation.provider === 'mock';
  const decided = evaluation.appeals.some((a) => a.status === 'decided');
  const pending = !demo && (scores.incomplete || evaluation.needs_review);
  const reviewNote = scores.incomplete && scores.total !== null
    ? 'Балл рассчитан по оценённым критериям. Остальные требуют проверки.' : 'Оценка требует проверки.';
  const scoredSections = new Set(evaluation.criteria.filter((c) => c.type !== 'flag' && c.weight > 0).map((c) => c.section));
  const sections = scores.sections.filter((s) => scoredSections.has(s.id));
  return html`<section class="score" aria-labelledby="score-title">
    <div class="score__summary">
      <h2 id="score-title">${demo ? 'Тестовый балл' : pending ? 'Предварительный балл' : 'Финальный балл'}</h2>
      ${scores.total === null ? html`<p class="score__missing">Балл не рассчитан</p>` : html`
        <p class="score__amount"><strong class="score__value">${fmt(scores.total)}</strong> <span>из 100</span></p>`}
      <dl class="score__source">
        <div><dt>Чек-лист</dt><dd title="${evaluation.checklist_name}">${evaluation.checklist_version_id}</dd></div>
        ${decided ? html`<div><dt>До апелляций</dt><dd>${fmt(evaluation.original.scores.total)}</dd></div>` : ''}
        <div><dt>Модель</dt><dd>${demo ? 'Заглушка' : evaluation.model || 'Не указана'}</dd></div>
      </dl>
    </div>
    ${sections.length ? html`<div class="score__breakdown">
      <h3>Баллы по разделам</h3>
      <div class="sections">
        ${sections.map((s) => html`<a class="section-score" href="#group-${s.id}" data-group="${s.id}">
          <span class="section-score__ring" style="--fill:${s.total ?? 0}%">
            <strong>${fmt(s.total)}</strong>${s.total !== null ? html`<small>из 100</small>` : ''}
          </span>
          <span>${s.title}</span>
          ${s.total === null ? html`<small class="muted">Без балла</small>` : ''}
        </a>`)}
      </div>
      <p class="muted score__hint">Итог учитывает вес каждого применимого критерия.</p>
    </div>` : ''}
    ${demo ? demoNote : ''}
    ${scores.gross_error ? html`<p class="${demo ? 'review-note' : 'gross-flag'}">${demo ? 'Пример отметки о грубой ошибке' : 'Отмечена грубая ошибка'}. Учитывается отдельно от балла.</p>` : ''}
    ${pending ? html`<p class="review-note">${reviewNote}</p>` : ''}
  </section>`;
}

function resultPanel(evaluation, evaluations, versions, context) {
  const picker = html`<div class="result__controls">
    ${evaluations.length ? html`<label class="field field--inline">Сохранённая оценка
      <select data-select="evaluation">
        ${evaluations.map((e, i) => html`<option value="${e.id}" ${e.id === evaluation?.id ? 'selected' : ''}>
          №${evaluations.length - i} · ${e.checklist_version_id} · ${STATUS_NAMES[e.status]}</option>`)}
      </select></label>` : ''}
    <form class="reeval" data-form="reevaluate">
      <label class="field field--inline">Чек-лист для новой оценки
        <select name="version">${versions.map((v) => html`<option value="${v.id}" ${v.id === evaluation?.checklist_version_id ? 'selected' : ''}>${v.id} · ${v.name}</option>`)}</select>
      </label>
      <button class="btn" type="submit">${evaluations.length ? 'Оценить заново' : 'Оценить'}</button>
    </form>
  </div>`;

  if (!evaluation) return html`${picker}<p class="empty">Диалог ещё не оценивался.</p>`;
  if (evaluation.status === 'queued' || evaluation.status === 'running') {
    return html`${picker}<p class="empty" aria-live="polite">Оценка ${STATUS_NAMES[evaluation.status]}…</p>`;
  }
  if (evaluation.status === 'failed') return html`${picker}<div class="panel panel--error" role="alert"><p>Оценка не удалась. ${evaluation.error}</p></div>`;

  const groups = evaluation.sections.map((s) => ({ ...s, criteria: evaluation.criteria.filter((c) => c.section === s.id) }))
    .filter((s) => s.criteria.length);
  return html`${picker}
    ${evaluation.intent && !context.demo ? html`<p class="crit__why"><strong>Запрос клиента</strong>${evaluation.intent}</p>` : ''}
    ${!context.demo && (evaluation.cost_usd > 0 || evaluation.attempts > 1) ? html`<details class="crit__history">
      <summary>Технические сведения</summary>
      <p>Попыток оценки ${evaluation.attempts}${evaluation.cost_usd > 0 ? ` · Стоимость $${evaluation.cost_usd.toFixed(4)}` : ''}</p>
    </details>` : ''}
    ${groups.map((s) => html`<section class="crit-group" aria-labelledby="group-${s.id}">
      <h3 id="group-${s.id}" tabindex="-1">${s.title}</h3>
      ${s.criteria.map((c) => criterionBlock(c, evaluation, context))}</section>`)}`;
}

export function seek(audio, sec, { play }) {
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

function flash(node, className, block = 'center') {
  node.classList.remove('is-target', 'is-expected');
  void node.offsetWidth;
  node.classList.add(className);
  node.scrollIntoView({ block, behavior: reducedMotion() ? 'auto' : 'smooth' });
  node.focus({ preventScroll: true });
  setTimeout(() => node.classList.remove(className), 2600);
}

export async function render(container, state) {
  const route = state.route;
  const { id, e: requestedEvaluation } = route;
  let data;
  let evaluation = null;
  let versions;
  try {
    [data, versions] = await Promise.all([api.conversation(id), api.checklists()]);
    const chosen = data.evaluations.find((item) => item.id === requestedEvaluation)
      ?? data.evaluations.find((item) => item.status === 'done') ?? data.evaluations[0];
    if (chosen) evaluation = await api.evaluation(chosen.id);
  } catch (error) {
    if (route !== state.route) return;
    const root = mountView(container, errorPanel(error));
    root.querySelector('[data-action=retry]').addEventListener('click', () => render(container, state));
    return;
  }
  if (route !== state.route) return;

  const conv = data.conversation;
  const isVoice = conv.channel === 'voice call';
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const changes = new Map(evaluation?.appeals.filter((a) => a.status === 'decided' && a.action === 'change')
    .map((a) => [a.criterion_id, a]) ?? []);
  const cites = citationMap(evaluation?.status === 'done' ? evaluation : null, changes);
  const demo = (evaluation?.provider ?? state.health?.provider) === 'mock';
  const context = { byId, isVoice, demo, role: state.role, changes };
  const hasScore = evaluation?.status === 'done' && evaluation.final;

  const root = mountView(container, html`
    <section class="page-head page-head--card">
      <a href="?view=list" data-nav class="back">К списку диалогов</a>
      <h1>Диалог ${conv.conversation_id}</h1>
      <p class="chips"><span class="chip">${CHANNEL_NAMES[conv.channel] ?? conv.channel}</span>
        <span class="chip">${LANGUAGE_NAMES[conv.language] ?? 'Язык не указан'}</span>
        <span class="chip">Реплик ${conv.messages.length}</span><span class="chip">Набор ${conv.group_id}</span></p>
    </section>
    ${hasScore ? scoreHead(evaluation) : demo ? demoNote : ''}
    ${hasScore ? critPath(evaluation, demo) : ''}
    <div class="card">
      <section class="transcript" aria-labelledby="transcript-title">
        <header class="transcript__head">
          <h2 id="transcript-title">Реплики диалога</h2>
          <p>Текст на языке оригинала. Оценка касается работы оператора.</p>
        </header>
        ${isVoice && conv.has_audio ? html`<div class="player">
          <audio controls preload="none" src="${api.audioUrl(conv.conversation_id)}"></audio>
          <p class="player__note" data-player-note>Позиция в записи считается от старта записи без пауз. Воспроизведение начинается на 2 секунды раньше реплики.</p>
        </div>` : ''}
        <div class="transcript__list">${conv.messages.map((m) => messageRow(m, cites.get(m.id), isVoice))}</div>
      </section>
      <section class="result" aria-labelledby="result-title">
        <h2 id="result-title">Разбор по чек-листу</h2>
        ${resultPanel(evaluation, data.evaluations, versions, context)}
      </section>
    </div>`);

  const audio = root.querySelector('audio');

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

  async function requestCoach(button) {
    button.disabled = true;
    button.textContent = 'Готовлю подсказку…';
    try {
      const coach = await api.coach(evaluation.id, button.dataset.coachBtn);
      button.closest('[data-coach]').innerHTML = String(coachView(coach));
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Как надо было ответить';
    }
  }

  root.addEventListener('click', (event) => {
    const coachButton = event.target.closest('[data-coach-btn]');
    if (coachButton) {
      event.preventDefault();
      requestCoach(coachButton);
      return;
    }
    // Полоска критериев: открывает критерий и реплику, на которую он опирается.
    const pathLink = event.target.closest('[data-path]');
    if (pathLink) {
      event.preventDefault();
      if (pathLink.dataset.pathMsg) focusMessage(pathLink.dataset.pathMsg, pathLink.dataset.pathKind);
      const node = root.querySelector(`#crit-${CSS.escape(pathLink.dataset.path)}`);
      if (node) flash(node, 'is-target');
      return;
    }
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
    const groupLink = event.target.closest('[data-group]');
    if (groupLink) {
      event.preventDefault();
      const heading = root.querySelector(`#group-${CSS.escape(groupLink.dataset.group)}`);
      if (heading) flash(heading, 'is-target', 'start');
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
    state.schedule(container, () => render(container, state), 1500);
  }
}
