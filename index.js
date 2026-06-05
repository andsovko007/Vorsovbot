import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';

const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_CHAT_ID: String(process.env.ADMIN_CHAT_ID || '').trim(),
  SHEETS_WEBAPP_URL: process.env.SHEETS_WEBAPP_URL,
  SHEETS_API_SECRET: process.env.SHEETS_API_SECRET,
  TEST_MODE: String(process.env.TEST_MODE || 'false') === 'true',
  ALLOW_TEST_COMMANDS: String(process.env.ALLOW_TEST_COMMANDS || 'false') === 'true',
  WARMUP_FAST_DELAY_MS: Number(process.env.WARMUP_FAST_DELAY_MS || 1200),
};

if (!ENV.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!ENV.SHEETS_WEBAPP_URL) throw new Error('SHEETS_WEBAPP_URL is required');
if (!ENV.SHEETS_API_SECRET) throw new Error('SHEETS_API_SECRET is required');

const bot = new Bot(ENV.BOT_TOKEN);
const sessions = new Map();
let CONTENT = null;
let LAST_CONTENT_LOAD = 0;

const CRM_STATUS = {
  new: 'Новый',
  quiz_started: 'Начал диагностику',
  quiz_completed: 'Прошёл диагностику',
  clicked_booking: 'Нажал разбор',
  clicked_channel: 'Перешёл в канал',
  in_warmup: 'В прогреве',
  manual_contact_needed: 'Связаться вручную',
  booked_call: 'Записан на разбор',
  call_done: 'Разбор проведён',
  reservation: 'Бронь',
  deal: 'Сделка',
  warmup_stopped: 'Прогрев остановлен',
  not_relevant: 'Нецелевой',
};

function isAdmin(ctx) {
  return String(ctx.from?.id || '').trim() === String(ENV.ADMIN_CHAT_ID || '').trim();
}

async function apiGet(action) {
  const url = new URL(ENV.SHEETS_WEBAPP_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('secret', ENV.SHEETS_API_SECRET);

  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Sheets API error');
  return json;
}

async function apiPost(action, payload = {}, operations = null) {
  const res = await fetch(ENV.SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: ENV.SHEETS_API_SECRET,
      action,
      payload,
      operations,
    }),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Sheets API error');
  return json;
}

function parseRows(rows) {
  const content = {
    settings: {},
    start: null,
    questions: [],
    optionsByQuestion: {},
    segments: {},
    ctaMatrix: {},
    warmup: [],
  };

  for (const r of rows) {
    if (String(r.active).toUpperCase() !== 'TRUE') continue;

    const block = String(r.block || '');
    const id = String(r.id || '');

    if (block === 'settings') {
      content.settings[r.key] = r.value;
    }

    if (block === 'start') {
      content.start = r;
    }

    if (block === 'question') {
      content.questions.push(r);
    }

    if (block === 'option') {
      const parent = String(r.parent_id || '');
      if (!content.optionsByQuestion[parent]) content.optionsByQuestion[parent] = [];
      content.optionsByQuestion[parent].push(r);
    }

    if (block === 'segment') {
      content.segments[id] = r;
    }

    if (block === 'cta_matrix') {
      content.ctaMatrix[`${r.segment}_${r.readiness}`] = r;
    }

    if (block === 'warmup') {
      content.warmup.push(r);
    }
  }

  content.questions.sort((a, b) => Number(a.order) - Number(b.order));
  for (const qid of Object.keys(content.optionsByQuestion)) {
    content.optionsByQuestion[qid].sort((a, b) => Number(a.order) - Number(b.order));
  }
  content.warmup.sort((a, b) => Number(a.order) - Number(b.order));

  return content;
}

async function loadContent(force = false) {
  const now = Date.now();
  if (!force && CONTENT && now - LAST_CONTENT_LOAD < 60_000) return CONTENT;

  const json = await apiGet('getContent');
  CONTENT = parseRows(json.content);
  LAST_CONTENT_LOAD = now;
  return CONTENT;
}

async function getCrmLeads() {
  const json = await apiGet('getCrmLeads');
  return json.leads || [];
}

function callback(type, value) {
  return `${type}:${value}`;
}

function parseTag(comment, tag) {
  const m = String(comment || '').match(new RegExp(`${tag}=([^\\s]+)`));
  return m ? m[1] : '';
}

function keyboardForOptions(questionId, options) {
  const kb = new InlineKeyboard();
  for (const opt of options) {
    kb.text(String(opt.text), callback('answer', opt.id)).row();
  }
  return kb;
}

function actionKeyboard(buttons, settings) {
  const kb = new InlineKeyboard();

  for (const b of buttons) {
    if (!b.text || !b.type) continue;

    if (b.type === 'booking') {
      kb.url(b.text, settings.booking_url);
    } else if (b.type === 'channel') {
      kb.url(b.text, settings.channel_url);
    } else if (b.type === 'restart') {
      kb.text(b.text, callback('restart', '1'));
    } else if (b.type === 'reviews') {
      kb.url(b.text, settings.channel_url);
    }
    kb.row();
  }

  return kb;
}

async function sendHtml(ctxOrBot, chatIdOrText, maybeText, maybeKeyboard) {
  // Overloaded:
  // sendHtml(ctx, text, keyboard)
  // sendHtml(bot, chatId, text, keyboard)
  if (typeof chatIdOrText === 'string') {
    return ctxOrBot.reply(chatIdOrText, { parse_mode: 'HTML', reply_markup: maybeText });
  }

  return ctxOrBot.api.sendMessage(chatIdOrText, maybeText, {
    parse_mode: 'HTML',
    reply_markup: maybeKeyboard,
  });
}

function getUser(ctx) {
  return {
    telegram_id: String(ctx.from?.id || ''),
    username: ctx.from?.username || '',
    name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' '),
  };
}

async function logEvent(user, event_type, extra = {}) {
  try {
    await apiPost('appendEvent', {
      event_id: `${event_type}_${user.telegram_id}_${Date.now()}`,
      timestamp: new Date().toISOString(),
      telegram_id: user.telegram_id,
      username: user.username,
      name: user.name,
      event_type,
      payload: extra.payload || {},
      segment_code: extra.segment_code || '',
      readiness: extra.readiness || '',
      source: extra.source || 'telegram',
    });
  } catch (e) {
    console.error('appendEvent failed:', e.message);
  }
}

async function upsertLead(user, data = {}) {
  try {
    await apiPost('upsertLead', {
      telegram_id: user.telegram_id,
      username: user.username,
      name: user.name,
      source: data.source || 'telegram',
      ...data,
    });
  } catch (e) {
    console.error('upsertLead failed:', e.message);
  }
}

async function appendDiagnosis(user, data) {
  try {
    await apiPost('appendDiagnosis', {
      diagnosis_id: `diag_${user.telegram_id}_${Date.now()}`,
      completed_at: new Date().toISOString(),
      telegram_id: user.telegram_id,
      username: user.username,
      name: user.name,
      ...data,
    });
  } catch (e) {
    console.error('appendDiagnosis failed:', e.message);
  }
}

async function askQuestion(ctx, session) {
  const content = await loadContent();
  const q = content.questions[session.index];
  if (!q) return finishQuiz(ctx, session);

  const options = content.optionsByQuestion[q.id] || [];
  await sendHtml(ctx, String(q.text), keyboardForOptions(q.id, options));
}

function calculateReadiness(session) {
  let maxWeight = 0;
  let result = '';

  for (const opt of Object.values(session.selectedOptions)) {
    const w = Number(opt.readiness_weight || 0);
    if (w > maxWeight) {
      maxWeight = w;
      result = String(opt.readiness || '');
    }
  }

  return result || 'cold';
}

function collectTags(session) {
  let goal_tag = '';
  let payment_tag = '';

  for (const opt of Object.values(session.selectedOptions)) {
    goal_tag ||= parseTag(opt.comment, 'goal_tag');
    payment_tag ||= parseTag(opt.comment, 'payment_tag');
  }

  return { goal_tag, payment_tag };
}

async function finishQuiz(ctx, session) {
  const content = await loadContent();
  const user = getUser(ctx);
  const readiness = calculateReadiness(session);
  const tags = collectTags(session);

  const q5 = session.selectedOptions.q5;
  const segment_code = String(q5?.segment || 'D');
  const segment = content.segments[segment_code] || content.segments.D;
  const segment_name = String(segment.comment || segment.id);
  const cta = content.ctaMatrix[`${segment_code}_${readiness}`] || content.ctaMatrix[`${segment_code}_cold`];

  const buttons = [
    { text: cta.button_1, type: cta.type_1 },
    { text: cta.button_2, type: cta.type_2 },
  ].filter(b => b.text);

  await sendHtml(ctx, String(segment.text), actionKeyboard(buttons, content.settings));

  const answers = {
    q1: session.answers.q1 || '',
    q2: session.answers.q2 || '',
    q3: session.answers.q3 || '',
    q4: session.answers.q4 || '',
    q5: session.answers.q5 || '',
    q6: session.answers.q6 || '',
    q7: session.answers.q7 || '',
  };

  const leadData = {
    ...answers,
    segment_code,
    segment_name,
    readiness,
    goal_tag: tags.goal_tag,
    payment_tag: tags.payment_tag,
    last_cta: '',
    status: CRM_STATUS.quiz_completed,
    diagnosis_completed_at: new Date().toISOString(),
    warmup_started_at: new Date().toISOString(),
    current_warmup_day: 2,
    hot_followup_sent: false,
  };

  await upsertLead(user, leadData);
  await appendDiagnosis(user, { ...answers, segment_code, segment_name, readiness, ...tags });
  await logEvent(user, 'quiz_completed', { segment_code, readiness });
  await logEvent(user, 'result_sent', { segment_code, readiness });

  if (ENV.ADMIN_CHAT_ID) {
    const managerHint = readiness === 'hot'
      ? 'Горячий — позвонить сегодня'
      : readiness === 'warm'
      ? 'Тёплый — написать в течение дня'
      : 'Холодный — в прогрев';

    await bot.api.sendMessage(
      ENV.ADMIN_CHAT_ID,
      [
        '🔔 Новая диагностика',
        `Имя: ${user.name}`,
        `Username: @${user.username || '-'}`,
        '',
        `Q1: ${answers.q1 || '-'}`,
        `Q2: ${answers.q2 || '-'}`,
        `Q3: ${answers.q3 || '-'}`,
        `Q4: ${answers.q4 || '-'}`,
        `Q5: ${answers.q5 || '-'}`,
        `Q6: ${answers.q6 || '-'}`,
        `Q7: ${answers.q7 || '-'}`,
        '',
        `Сегмент: ${segment_code} — ${segment_name}`,
        `Готовность: ${readiness}`,
        `Подсказка: ${managerHint}`,
      ].join('\n')
    );
  }

  sessions.delete(user.telegram_id);
}

async function startQuiz(ctx) {
  const content = await loadContent();
  const user = getUser(ctx);

  const session = {
    user,
    index: 0,
    answers: {},
    selectedOptions: {},
  };

  sessions.set(user.telegram_id, session);

  await askQuestion(ctx, session);

  background('quiz_started_upsert', upsertLead(user, { status: CRM_STATUS.quiz_started }));
  background('quiz_started_event', logEvent(user, 'quiz_started'));
}

bot.command('start', async (ctx) => {
  const content = await loadContent();
  const user = getUser(ctx);

  const kb = new InlineKeyboard().text(content.start.button_1 || 'Начать', callback('start_quiz', '1'));
  await sendHtml(ctx, String(content.start.text), kb);

  background('bot_started_upsert', upsertLead(user, { status: CRM_STATUS.new }));
  background('bot_started_event', logEvent(user, 'bot_started'));
});

bot.callbackQuery(/^start_quiz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await startQuiz(ctx);
});

bot.callbackQuery(/^restart:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await startQuiz(ctx);
});

bot.callbackQuery(/^answer:/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const content = await loadContent();
  const user = getUser(ctx);
  const session = sessions.get(user.telegram_id);

  if (!session) {
    await ctx.reply('Диагностика не найдена. Нажмите /start и начните заново.');
    return;
  }

  const optionId = ctx.callbackQuery.data.split(':')[1];
  const q = content.questions[session.index];
  const opts = content.optionsByQuestion[q.id] || [];
  const opt = opts.find(o => String(o.id) === optionId);

  if (!opt) {
    await ctx.reply('Ответ не найден. Нажмите /start и начните заново.');
    return;
  }

  session.answers[q.id] = String(opt.text);
  session.selectedOptions[q.id] = opt;
  session.index += 1;

  background('question_answered', logEvent(user, 'question_answered', { payload: { question_id: q.id, option_id: optionId, text: opt.text } }));

  if (session.index >= content.questions.length) {
    await finishQuiz(ctx, session);
  } else {
    await askQuestion(ctx, session);
  }
});

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return next();

  const user = getUser(ctx);

  if (['стоп', 'stop', 'остановить', 'не писать'].includes(text.trim().toLowerCase())) {
    await upsertLead(user, { status: CRM_STATUS.warmup_stopped, warmup_stopped_at: new Date().toISOString() });
    await logEvent(user, 'warmup_stopped');
    await ctx.reply('Ок, прогрев остановлен.');
    return;
  }

  await logEvent(user, 'text_message_received', { payload: { text } });
  await upsertLead(user, { status: CRM_STATUS.manual_contact_needed });

  if (ENV.ADMIN_CHAT_ID) {
    await bot.api.sendMessage(ENV.ADMIN_CHAT_ID, `Пользователь написал в бот:\n${user.name} @${user.username || '-'}\n\n${text}`);
  }

  await ctx.reply('Сообщение получили. Если хотите быстрее разобрать ситуацию, нажмите кнопку ниже.', {
    reply_markup: new InlineKeyboard().url('Записаться на разбор', (await loadContent()).settings.booking_url),
  });
});

bot.command('myid', async (ctx) => {
  const id = String(ctx.from?.id || '').trim();
  await ctx.reply(`your_id=${id}\nadmin_id=${ENV.ADMIN_CHAT_ID}\nmatch=${id === ENV.ADMIN_CHAT_ID}`);
});

bot.command('health', async (ctx) => {
  if (!isAdmin(ctx)) {
    const id = String(ctx.from?.id || '');
    await ctx.reply(`Нет доступа\nyour_id=${id}\nadmin_id=${ENV.ADMIN_CHAT_ID}`);
    return;
  }
  try {
    const health = await apiGet('health');
    const content = await loadContent(true);
    const qOk = content.questions.length === 7;
    const sOk = Object.keys(content.segments).length === 4;
    await ctx.reply([
      '✅ Бот жив',
      `✅ API health: ok (ts=${health.ts})`,
      '✅ Контент читается',
      `${qOk ? '✅' : '❌'} Вопросов: ${content.questions.length} (ожидается 7)`,
      `${sOk ? '✅' : '❌'} Сегментов: ${Object.keys(content.segments).length} (ожидается 4)`,
    ].join('\n'));
  } catch (e) {
    await ctx.reply(`❌ ERROR\n${e.message}`);
  }
});

bot.command('admin_reload', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await loadContent(true);
  await ctx.reply('Контент перечитан из Google Sheets.');
});

bot.command('admin_preview_warmup', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const content = await loadContent(true);
  const rows = content.warmup.filter(r =>
    r.id === 'hot_1' || (String(r.id).startsWith('day_') && r.id !== 'day_1')
  );

  for (const row of rows) {
    await sendHtml(ctx, `<b>${row.id}</b>\n\n${row.text}`, actionKeyboard([
      { text: row.button_1, type: row.type_1 },
      { text: row.button_2, type: row.type_2 },
    ], content.settings));
    await delay(ENV.WARMUP_FAST_DELAY_MS);
  }
});

bot.command('admin_preview_all', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const content = await loadContent(true);

  await sendHtml(ctx, content.start.text);

  for (const q of content.questions) {
    await sendHtml(ctx, q.text, keyboardForOptions(q.id, content.optionsByQuestion[q.id] || []));
    await delay(500);
  }

  for (const [code, seg] of Object.entries(content.segments)) {
    await sendHtml(ctx, `<b>Сегмент ${code}</b>\n\n${seg.text}`);
    await delay(500);
  }

  await ctx.reply('Дальше прогрев. Запустите /admin_preview_warmup');
});

bot.command('admin_preview_warmup_day', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const day = (ctx.message.text.split(' ')[1] || '').trim();
  const content = await loadContent(true);
  const row = content.warmup.find(r => r.id === `day_${day}` || r.id === day);

  if (!row) return ctx.reply('День не найден.');

  await sendHtml(ctx, row.text, actionKeyboard([
    { text: row.button_1, type: row.type_1 },
    { text: row.button_2, type: row.type_2 },
  ], content.settings));
});

bot.command('test_user', async (ctx) => {
  if (!isAdmin(ctx) || !ENV.ALLOW_TEST_COMMANDS) return;

  const [, segment = 'A', readiness = 'hot'] = ctx.message.text.split(/\s+/);
  const content = await loadContent(true);
  const seg = content.segments[segment] || content.segments.A;
  const cta = content.ctaMatrix[`${segment}_${readiness}`] || content.ctaMatrix[`${segment}_hot`];

  await sendHtml(ctx, seg.text, actionKeyboard([
    { text: cta.button_1, type: cta.type_1 },
    { text: cta.button_2, type: cta.type_2 },
  ], content.settings));

  await ctx.reply(`Тест: segment=${segment}, readiness=${readiness}`);
});

bot.command('test_warmup_fast', async (ctx) => {
  if (!isAdmin(ctx) || !ENV.ALLOW_TEST_COMMANDS) return;
  const content = await loadContent(true);

  const rows = content.warmup.filter(r => String(r.id).startsWith('day_') && r.id !== 'day_1');

  for (const row of rows) {
    await sendHtml(ctx, `<b>${row.id}</b>\n\n${row.text}`, actionKeyboard([
      { text: row.button_1, type: row.type_1 },
      { text: row.button_2, type: row.type_2 },
    ], content.settings));
    await delay(ENV.WARMUP_FAST_DELAY_MS);
  }
});

bot.command('test_hot_followup', async (ctx) => {
  if (!isAdmin(ctx) || !ENV.ALLOW_TEST_COMMANDS) return;
  const content = await loadContent(true);
  const row = content.warmup.find(r => r.id === 'hot_1');
  await sendHtml(ctx, row.text, actionKeyboard([{ text: row.button_1, type: row.type_1 }], content.settings));
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function background(taskName, promise) {
  promise.catch((e) => console.error(`[BG] ${taskName} failed:`, e.message));
}

async function runWarmupTick() {
  try {
    const content = await loadContent();
    const leads = await getCrmLeads();

    const active = leads.filter(l => l.warmup_started_at && !l.warmup_stopped_at);
    console.log(`Warmup tick: ${active.length} active leads`);

    for (const lead of active) {
      const day = Math.max(2, Number(lead.current_warmup_day || 2));
      const sendAfter = new Date(
        new Date(lead.warmup_started_at).getTime() + (day - 1) * 24 * 60 * 60 * 1000
      );
      if (Date.now() < sendAfter.getTime()) continue;

      const row = content.warmup.find(r => r.id === `day_${day}`);

      if (!row) {
        await upsertLead(
          { telegram_id: String(lead.telegram_id), username: '', name: '' },
          { warmup_stopped_at: new Date().toISOString(), status: CRM_STATUS.warmup_stopped }
        );
        console.log(`Warmup complete: ${lead.telegram_id}`);
        continue;
      }

      try {
        await sendHtml(bot, Number(lead.telegram_id), String(row.text), actionKeyboard([
          { text: row.button_1, type: row.type_1 },
          { text: row.button_2, type: row.type_2 },
        ], content.settings));

        await upsertLead(
          { telegram_id: String(lead.telegram_id), username: '', name: '' },
          { current_warmup_day: day + 1, status: CRM_STATUS.in_warmup }
        );

        console.log(`Warmup sent: ${lead.telegram_id} day=${day}`);
      } catch (sendErr) {
        console.error(`Warmup send failed for ${lead.telegram_id}:`, sendErr.message);
      }
    }
  } catch (e) {
    console.error('Warmup tick error:', e.message);
  }
}

cron.schedule('0 * * * *', runWarmupTick);

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot started: @${botInfo.username}`);
  },
});
