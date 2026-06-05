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

const VORSOV_API_SECRET = 'CHANGE_ME_SECRET';

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

function upsertLead_(p) {
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
  // при update берём existing[N] если новое значение пустое
  const keep = (val, fallback) => {
    if (val !== undefined && val !== null && val !== '') return val;
    if (fallback !== undefined && fallback !== null && fallback !== '') return fallback;
    return '';
  };

  const row = [
    existing ? existing[0] : (p.created_at || now),
    p.last_event_at || now,
    telegramId,
    keep(p.username, e[3]),
    keep(p.name, e[4]),
    keep(p.source, e[5]) || 'telegram',
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
    keep(p.status, e[19]),
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
