/**
 * ВОРСОВ — APPS SCRIPT API ДЛЯ БОТА
 *
 * Вставить в Apps Script той же Google Sheets таблицы НИЖЕ кода сборки таблицы.
 * Потом: Deploy → New deployment → Web app
 * Execute as: Me
 * Who has access: Anyone
 *
 * В Railway указать:
 * SHEETS_WEBAPP_URL = URL Web App
 * SHEETS_API_SECRET = такой же секрет, как ниже
 */

const VORSOV_API_SECRET = 'vorsov_secret_2026';

function doGet(e) {
  try {
    assertApiSecret_(e.parameter.secret);

    const action = e.parameter.action;

    if (action === 'health') {
      return jsonResponse_({ ok: true, service: 'vorsov_sheets_api', ts: new Date().toISOString() });
    }

    if (action === 'getContent') {
      return jsonResponse_({ ok: true, content: getBotContent_() });
    }

    if (action === 'getCrmLeads') {
      return jsonResponse_({ ok: true, leads: getCrmLeads_() });
    }

    return jsonResponse_({ ok: false, error: 'Unknown GET action' });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    assertApiSecret_(body.secret);

    const action = body.action;
    const payload = body.payload || {};

    if (action === 'upsertLead') {
      const result = upsertLead_(payload);
      return jsonResponse_({ ok: true, result });
    }

    if (action === 'appendEvent') {
      appendEvent_(payload);
      return jsonResponse_({ ok: true });
    }

    if (action === 'appendDiagnosis') {
      appendDiagnosis_(payload);
      return jsonResponse_({ ok: true });
    }

    if (action === 'batch') {
      const results = [];
      (body.operations || []).forEach(op => {
        if (op.action === 'upsertLead') results.push(upsertLead_(op.payload || {}));
        if (op.action === 'appendEvent') { appendEvent_(op.payload || {}); results.push({ event: true }); }
        if (op.action === 'appendDiagnosis') { appendDiagnosis_(op.payload || {}); results.push({ diagnosis: true }); }
      });
      return jsonResponse_({ ok: true, results });
    }

    return jsonResponse_({ ok: false, error: 'Unknown POST action' });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
}

function assertApiSecret_(secret) {
  if (!secret || secret !== VORSOV_API_SECRET) {
    throw new Error('Unauthorized');
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getBotContent_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Бот');
  if (!sheet) throw new Error('Лист Бот не найден');

  const values = sheet.getDataRange().getValues();
  const headers = values.shift();

  return values
    .filter(row => String(row[0] || '').trim())
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    });
}

function getCrmLeads_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CRM');
  if (!sheet) throw new Error('Лист CRM не найден');

  const values = sheet.getDataRange().getValues();
  values.shift(); // убираем заголовки — возвращаем по индексам, не по русским именам

  return values
    .filter(row => row[2]) // col 3 = telegram_id
    .map(row => ({
      created_at:             row[0],
      last_event_at:          row[1],
      telegram_id:            String(row[2]),
      username:               row[3],
      name:                   row[4],
      source:                 row[5],
      q1:                     row[6],
      q2:                     row[7],
      q3:                     row[8],
      q4:                     row[9],
      q5:                     row[10],
      q6:                     row[11],
      q7:                     row[12],
      segment_code:           row[13],
      segment_name:           row[14],
      readiness:              row[15],
      goal_tag:               row[16],
      payment_tag:            row[17],
      last_cta:               row[18],
      status:                 row[19],
      manager:                row[20],
      comment:                row[21],
      diagnosis_completed_at: row[22],
      warmup_started_at:      row[23],
      current_warmup_day:     row[24],
      hot_followup_sent:      row[25],
      warmup_stopped_at:      row[26],
    }));
}

var STATUS_RANK_ = {
  'Новый':               0,
  'Начал диагностику':   1,
  'Прошёл диагностику':  2,
  'В прогреве':          3,
  'Прогрев остановлен':  3,
  'Прогрев завершён':    3,
  'Перешёл в канал':     4,
  'Связаться вручную':   4,
  'Нажал разбор':        5,
  'Записан на разбор':   6,
  'Разбор проведён':     7,
  'Бронь':               8,
  'Сделка':              9,
  'Нецелевой':           9
};
var LOCKED_STATUSES_ = ['Сделка', 'Нецелевой'];

function safeStatus_(newStatus, existingStatus) {
  if (!newStatus) return existingStatus || '';
  if (!existingStatus) return newStatus;
  if (LOCKED_STATUSES_.indexOf(existingStatus) !== -1) return existingStatus;
  var newRank   = STATUS_RANK_.hasOwnProperty(newStatus)      ? STATUS_RANK_[newStatus]      : -1;
  var existRank = STATUS_RANK_.hasOwnProperty(existingStatus) ? STATUS_RANK_[existingStatus] : -1;
  if (newRank !== -1 && existRank !== -1 && newRank < existRank) return existingStatus;
  return newStatus;
}

function upsertLead_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('CRM');
    if (!sheet) throw new Error('Лист CRM не найден');

    const telegramId = String(p.telegram_id || '');
    if (!telegramId) throw new Error('telegram_id required');

    const now = new Date();
    const lastRow = Math.max(sheet.getLastRow(), 1);

    let targetRow = 0;
    if (lastRow >= 2) {
      const ids = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === telegramId) {
          targetRow = i + 2;
          break;
        }
      }
    }

    const existing = targetRow ? sheet.getRange(targetRow, 1, 1, 27).getValues()[0] : null;
    const e = existing || [];
    const keep = (val, fallback) => {
      if (val !== undefined && val !== null && val !== '') return val;
      if (fallback !== undefined && fallback !== null && fallback !== '') return fallback;
      return '';
    };

    const existingSource = String(e[5] || '');
    const incomingSource = String(p.source || '');

    const completedDiagnosisNow = Boolean(
      p.diagnosis_completed_at &&
      p.warmup_started_at
    );

    const sourceValue = existing
      ? (
          existingSource === 'internal' || existingSource === 'test'
            ? existingSource
            : (
                incomingSource === 'telegram_v2' &&
                completedDiagnosisNow
                  ? 'telegram_v2'
                  : (existingSource || incomingSource || 'telegram')
              )
        )
      : (incomingSource || 'telegram');

    // status: защита от отката и блокировка финальных статусов
    const statusValue = safeStatus_(p.status, existing ? String(e[19] || '') : '');

    const row = [
      existing ? existing[0] : (p.created_at || now),
      p.last_event_at || now,
      telegramId,
      keep(p.username, e[3]),
      keep(p.name, e[4]),
      sourceValue,
      keep(p.q1, e[6]),
      keep(p.q2, e[7]),
      keep(p.q3, e[8]),
      keep(p.q4, e[9]),
      keep(p.q5, e[10]),
      keep(p.q6, e[11]),
      keep(p.q7, e[12]),
      keep(p.segment_code, e[13]),
      keep(p.segment_name, e[14]),
      keep(p.readiness, e[15]),
      keep(p.goal_tag, e[16]),
      keep(p.payment_tag, e[17]),
      keep(p.last_cta, e[18]),
      statusValue,
      keep(p.manager, e[20]),
      keep(p.comment, e[21]),
      p.diagnosis_completed_at || (existing ? existing[22] : ''),
      p.warmup_started_at || (existing ? existing[23] : ''),
      p.current_warmup_day !== undefined ? p.current_warmup_day : (existing ? existing[24] : ''),
      p.hot_followup_sent !== undefined ? p.hot_followup_sent : (existing ? existing[25] : false),
      p.warmup_stopped_at || (existing ? existing[26] : '')
    ];

    if (targetRow) {
      sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
      return { updated: true, row: targetRow };
    }

    sheet.appendRow(row);
    return { inserted: true, row: sheet.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

function appendEvent_(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('_История событий');
  if (!sheet) throw new Error('Лист _История событий не найден');

  sheet.appendRow([
    p.event_id || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
    p.timestamp || new Date(),
    p.telegram_id || '',
    p.username || '',
    p.name || '',
    p.event_type || '',
    typeof p.payload === 'string' ? p.payload : JSON.stringify(p.payload || {}),
    p.segment_code || '',
    p.readiness || '',
    p.source || 'telegram'
  ]);
}

function appendDiagnosis_(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('_История диагностик');
  if (!sheet) throw new Error('Лист _История диагностик не найден');

  sheet.appendRow([
    p.diagnosis_id || ('diag_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
    p.completed_at || new Date(),
    p.telegram_id || '',
    p.username || '',
    p.name || '',
    p.q1 || '',
    p.q2 || '',
    p.q3 || '',
    p.q4 || '',
    p.q5 || '',
    p.q6 || '',
    p.q7 || '',
    p.segment_code || '',
    p.segment_name || '',
    p.readiness || '',
    p.goal_tag || '',
    p.payment_tag || ''
  ]);
}

// ==================================================
// CRM VALIDATION & FORMATTING
// ==================================================

function updateCrmStatusValidation_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CRM');
  if (!sheet) return;

  const VALID_STATUSES = [
    'Новый', 'Начал диагностику', 'Прошёл диагностику',
    'Нажал разбор', 'Перешёл в канал', 'В прогреве',
    'Связаться вручную', 'Записан на разбор', 'Разбор проведён',
    'Бронь', 'Сделка', 'Прогрев остановлен', 'Прогрев завершён', 'Нецелевой'
  ];

  const statusRange = sheet.getRange('T2:T1000');

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(VALID_STATUSES, true)
    .setAllowInvalid(true)
    .build();
  statusRange.setDataValidation(rule);

  const fmtRange = sheet.getRange('A2:AA1000');
  const colorMap = {
    'Сделка':             '#0f9d58',
    'Бронь':              '#34a853',
    'Записан на разбор':  '#4285f4',
    'Нажал разбор':       '#fbbc05',
    'Перешёл в канал':    '#fff176',
    'В прогреве':         '#b3e5fc',
    'Прошёл диагностику': '#e8f5e9',
    'Начал диагностику':  '#f1f8e9',
    'Новый':              '#ffffff',
    'Прогрев завершён':   '#eeeeee',
    'Прогрев остановлен': '#ffcdd2',
    'Нецелевой':          '#ffcdd2',
    'Связаться вручную':  '#ffe0b2',
    'Разбор проведён':    '#e8eaf6',
  };

  const rules = Object.keys(colorMap).map(function(status) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$T2="' + status + '"')
      .setBackground(colorMap[status])
      .setRanges([fmtRange])
      .build();
  });
  sheet.setConditionalFormatRules(rules);
}

// ==================================================
// DASHBOARD REPAIR (only touches Дашборд sheet)
// ==================================================

function repairDashboardAnalyticsOnly() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dashSheet = ss.getSheetByName('Дашборд');
  if (!dashSheet) throw new Error('Лист Дашборд не найден');

  var EXCLUDED_IDS = ['274328371', '289634658'];
  function isExcluded(tid) { return EXCLUDED_IDS.indexOf(String(tid)) !== -1; }

  // ── Events ────────────────────────────────────────────────────────────────
  var evtSheet = ss.getSheetByName('_История событий');
  var evtData  = evtSheet ? evtSheet.getDataRange().getValues() : [];
  if (evtData.length > 1) evtData.shift(); else evtData.splice(0);

  var events = evtData.filter(function(r) {
    var tid = String(r[2] || '');
    var src = String(r[9] || '');
    return tid && !isExcluded(tid) && src !== 'test' && src !== 'internal';
  });

  // byType[event_type][telegram_id] = true
  var byType = {};
  // bookingByOrigin[origin][telegram_id] = true
  var bookingByOrigin = {};

  events.forEach(function(r) {
    var etype = String(r[5] || '');
    var tid   = String(r[2] || '');
    if (!etype || !tid) return;
    if (!byType[etype]) byType[etype] = {};
    byType[etype][tid] = true;

    if (etype === 'booking_clicked') {
      var origin = '';
      try { origin = JSON.parse(String(r[6] || '{}')).origin || ''; } catch (_) {}
      if (origin) {
        if (!bookingByOrigin[origin]) bookingByOrigin[origin] = {};
        bookingByOrigin[origin][tid] = true;
      }
    }
  });

  function uniq(t)               { return Object.keys(byType[t] || {}).length; }
  function bookingOriginCount(o) { return Object.keys(bookingByOrigin[o] || {}).length; }
  // возвращает дробь 0..1; Sheets отображает как % при формате 0.00%
  function pct(num, den)         { return den ? Math.min(1, num / den) : 0; }

  // ── CRM — дедупликация по telegram_id (последняя строка побеждает) ────────
  var rawLeads = getCrmLeads_();
  var leadMap = {};
  rawLeads.forEach(function(l) { leadMap[String(l.telegram_id)] = l; });
  var allLeads = Object.keys(leadMap).map(function(tid) { return leadMap[tid]; });
  var crmLeads = allLeads.filter(function(l) { return !isExcluded(l.telegram_id); });
  var extLeads = crmLeads.filter(function(l) {
    var src = String(l.source || '');
    return src !== 'test' && src !== 'internal';
  });

  // Status counts
  var statusCounts = {};
  extLeads.forEach(function(l) {
    var s = String(l.status || '');
    if (s) statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  // tid → segment_code / readiness (для кросс-матчинга booking_clicked)
  var tidToSeg = {}, tidToRead = {};
  extLeads.forEach(function(l) {
    var tid = String(l.telegram_id);
    if (l.segment_code) tidToSeg[tid]  = l.segment_code;
    if (l.readiness)    tidToRead[tid] = l.readiness;
  });

  // Сегменты A-D: уникальные лиды, booking_clicked, channel_clicked
  var SEG_ORDER = ['A', 'B', 'C', 'D'];
  var segLeads = {}, segBooked = {}, segChannel = {};
  SEG_ORDER.forEach(function(c) { segLeads[c] = 0; segBooked[c] = {}; segChannel[c] = {}; });
  extLeads.forEach(function(l) {
    var code = String(l.segment_code || '');
    if (segLeads.hasOwnProperty(code)) segLeads[code]++;
  });
  Object.keys(byType['booking_clicked'] || {}).forEach(function(tid) {
    var seg = tidToSeg[tid];
    if (seg && segBooked.hasOwnProperty(seg)) segBooked[seg][tid] = true;
  });
  Object.keys(byType['channel_clicked'] || {}).forEach(function(tid) {
    var seg = tidToSeg[tid];
    if (seg && segChannel.hasOwnProperty(seg)) segChannel[seg][tid] = true;
  });

  // Готовность hot/warm/cold: уникальные лиды + booking_clicked
  var READ_ORDER = ['hot', 'warm', 'cold'];
  var readLeads = {hot: 0, warm: 0, cold: 0};
  var readBooked = {hot: {}, warm: {}, cold: {}};
  extLeads.forEach(function(l) {
    var r = String(l.readiness || '');
    if (readLeads.hasOwnProperty(r)) readLeads[r]++;
  });
  Object.keys(byType['booking_clicked'] || {}).forEach(function(tid) {
    var r = tidToRead[tid];
    if (r && readBooked.hasOwnProperty(r)) readBooked[r][tid] = true;
  });

  // CTA unique (booking OR channel)
  var ctaIds = {};
  Object.keys(byType['booking_clicked'] || {}).forEach(function(id) { ctaIds[id] = true; });
  Object.keys(byType['channel_clicked']  || {}).forEach(function(id) { ctaIds[id] = true; });
  var ctaTotal = Object.keys(ctaIds).length;

  // ── 1. KPI: A4:H4 ────────────────────────────────────────────────────────
  dashSheet.getRange('A4:H4').setValues([[
    extLeads.length,
    uniq('quiz_completed'),
    ctaTotal,
    uniq('booking_clicked'),
    uniq('channel_clicked'),
    statusCounts['Разбор проведён'] || 0,
    statusCounts['Бронь']           || 0,
    statusCounts['Сделка']          || 0
  ]]);

  // ── 2. Воронка: B8:B15, C8:C15 ───────────────────────────────────────────
  var funnelVals = [
    uniq('bot_started'),
    uniq('quiz_started'),
    uniq('quiz_completed'),
    ctaTotal,
    uniq('booking_clicked'),
    statusCounts['Разбор проведён'] || 0,
    statusCounts['Бронь']           || 0,
    statusCounts['Сделка']          || 0
  ];
  dashSheet.getRange('B8:B15').setValues(funnelVals.map(function(v) { return [v]; }));
  dashSheet.getRange('C8:C15').setValues(funnelVals.map(function(v, i) {
    if (i === 0) return [''];
    var prev = funnelVals[i - 1];
    return [prev ? pct(v, prev) : 0];
  }));
  dashSheet.getRange('C9:C15').setNumberFormat('0.00%');

  // ── 3. Статусы: E7, E8:F21 ───────────────────────────────────────────────
  dashSheet.getRange('E7').setValue('Текущие статусы CRM');
  dashSheet.getRange('E8:F21').setValues([
    ['Новый',                statusCounts['Новый']                || 0],
    ['Начал диагностику',    statusCounts['Начал диагностику']    || 0],
    ['Прошёл диагностику',   statusCounts['Прошёл диагностику']   || 0],
    ['В прогреве',           statusCounts['В прогреве']           || 0],
    ['Перешёл в канал',      statusCounts['Перешёл в канал']      || 0],
    ['Нажал разбор',         statusCounts['Нажал разбор']         || 0],
    ['Связаться вручную',    statusCounts['Связаться вручную']    || 0],
    ['Записан на разбор',    statusCounts['Записан на разбор']    || 0],
    ['Разбор проведён',      statusCounts['Разбор проведён']      || 0],
    ['Бронь',                statusCounts['Бронь']                || 0],
    ['Сделка',               statusCounts['Сделка']               || 0],
    ['Прогрев остановлен',   statusCounts['Прогрев остановлен']   || 0],
    ['Прогрев завершён',     statusCounts['Прогрев завершён']     || 0],
    ['Нецелевой',            statusCounts['Нецелевой']            || 0]
  ]);

  // ── 4. Сегменты: B24:E27 (A24:A27 не трогаем) ────────────────────────────
  dashSheet.getRange('B24:E27').setValues(
    SEG_ORDER.map(function(code) {
      var leads   = segLeads[code];
      var booked  = Object.keys(segBooked[code]).length;
      var channel = Object.keys(segChannel[code]).length;
      return [leads, booked, channel, pct(booked, leads)];
    })
  );
  dashSheet.getRange('E24:E27').setNumberFormat('0.00%');

  // ── 5. Готовность: G24:J26 ───────────────────────────────────────────────
  dashSheet.getRange('G24:J26').setValues(
    READ_ORDER.map(function(r) {
      var leads  = readLeads[r];
      var booked = Object.keys(readBooked[r]).length;
      return [r, leads, booked, pct(booked, leads)];
    })
  );
  dashSheet.getRange('J24:J26').setNumberFormat('0.00%');

  // ── 6. Прогрев: A32:D61 (30 строк) ──────────────────────────────────────
  var noMsgDays = [9, 11, 13, 23, 25];
  var warmupRows = [['Результат диагностики', uniq('result_sent'), bookingOriginCount('result'), '']];
  for (var day = 2; day <= 30; day++) {
    warmupRows.push([
      'День ' + day,
      uniq('warmup_day_' + day + '_sent'),
      bookingOriginCount('day_' + day),
      noMsgDays.indexOf(day) !== -1 ? 'Нет сообщения по плану' : ''
    ]);
  }
  dashSheet.getRange('A32:D61').setValues(warmupRows);

  // ── 7. Фокус: G32:G36 (G37 не трогаем) ───────────────────────────────────
  var hotDoneStatuses = ['Нажал разбор', 'Записан на разбор', 'Разбор проведён', 'Бронь', 'Сделка'];
  var hotActive = extLeads.filter(function(l) {
    return l.readiness === 'hot' && hotDoneStatuses.indexOf(String(l.status || '')) === -1;
  }).length;

  var noNextStep = extLeads.filter(function(l) {
    var st = String(l.status || '');
    return (st === 'Прошёл диагностику' || st === 'В прогреве') &&
           !l.last_cta &&
           !l.warmup_stopped_at;
  }).length;

  var activeV2 = crmLeads.filter(function(l) {
    return l.source === 'telegram_v2' && l.warmup_started_at && !l.warmup_stopped_at;
  }).length;

  var topSeg = SEG_ORDER[0];
  SEG_ORDER.forEach(function(code) {
    if (segLeads[code] > segLeads[topSeg]) topSeg = code;
  });
  var topSegLabel = segLeads[topSeg] > 0 ? 'Сегмент ' + topSeg + ' (' + segLeads[topSeg] + ')' : '—';

  dashSheet.getRange('G32:G36').setValues([
    [hotActive],
    [uniq('booking_clicked')],
    [noNextStep],
    [activeV2],
    [topSegLabel]
  ]);

  SpreadsheetApp.flush();
  console.log('Dashboard updated: ' + new Date().toISOString());
}

// ==================================================
// ENTRY POINT: apply to current spreadsheet
// Вызывать вручную из Apps Script Editor
// ==================================================

function applyFinalVorsovPatch() {
  updateCrmStatusValidation_();
  repairDashboardAnalyticsOnly();
  console.log('applyFinalVorsovPatch complete');
}

function installDashboardAutoRefresh() {
  var handler = 'repairDashboardAnalyticsOnly';

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyMinutes(10)
    .create();

  repairDashboardAnalyticsOnly();

  console.log('Dashboard auto-refresh installed');
}
