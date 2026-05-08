import { Bot, InlineKeyboard } from 'grammy';

const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_CHAT_ID: String(process.env.ADMIN_CHAT_ID || ''),
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
  return String(ctx.from?.id || '') === ENV.ADMIN_CHAT_ID;
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
    current_warmup_day: 1,
    hot_followup_sent: false,
  };

  await upsertLead(user, leadData);
  await appendDiagnosis(user, { ...answers, segment_code, segment_name, readiness, ...tags });
  await logEvent(user, 'quiz_completed', { segment_code, readiness });
  await logEvent(user, 'result_sent', { segment_code, readiness });

  if (ENV.ADMIN_CHAT_ID) {
    await bot.api.sendMessage(
      ENV.ADMIN_CHAT_ID,
      [
        'Новая диагностика',
        `Имя: ${user.name}`,
        `Username: @${user.username || '-'}`,
        `Сегмент: ${segment_code} — ${segment_name}`,
        `Готовность: ${readiness}`,
        `Стопор: ${answers.q5}`,
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

  await upsertLead(user, { status: CRM_STATUS.quiz_started });
  await logEvent(user, 'quiz_started');

  await askQuestion(ctx, session);
}

bot.command('start', async (ctx) => {
  const content = await loadContent();
  const user = getUser(ctx);

  await upsertLead(user, { status: CRM_STATUS.new });
  await logEvent(user, 'bot_started');

  const kb = new InlineKeyboard().text(content.start.button_1 || 'Начать', callback('start_quiz', '1'));

  await sendHtml(ctx, String(content.start.text), kb);
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

  await logEvent(user, 'question_answered', { payload: { question_id: q.id, option_id: optionId, text: opt.text } });

  if (session.index >= content.questions.length) {
    await finishQuiz(ctx, session);
  } else {
    await askQuestion(ctx, session);
  }
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return;

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

bot.command('health', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const health = await apiGet('health');
    const content = await loadContent(true);
    await ctx.reply(`OK\nSheets: ${health.ok}\nContent rows: ${Object.keys(content.segments).length} segments, ${content.questions.length} questions`);
  } catch (e) {
    await ctx.reply(`ERROR\n${e.message}`);
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
  const rows = content.warmup.filter(r => String(r.id).startsWith('day_') || r.id === 'hot_1');

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

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot started: @${botInfo.username}`);
  },
});
