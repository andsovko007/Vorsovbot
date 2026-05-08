# Ворсов Telegram Bot — Railway

## Что внутри

- Telegram-бот на Node.js + grammy
- Без Google service account
- Связь с Google Sheets через Apps Script Web App
- Диагностика 7 вопросов
- Сегменты A/B/C/D
- CRM + история событий + история диагностик
- Админ-команды для быстрой проверки всех сообщений без ожидания 30 дней

## 1. Apps Script API

1. Открой таблицу Google Sheets.
2. Расширения → Apps Script.
3. Вставь содержимое `apps_script_api.gs` ниже кода сборки таблицы.
4. В строке `VORSOV_API_SECRET` замени `CHANGE_ME_SECRET` на свой секрет.
5. Deploy → New deployment → Web app:
   - Execute as: Me
   - Who has access: Anyone
6. Скопируй Web App URL.

## 2. GitHub + Railway

1. Создай GitHub repo.
2. Залей туда файлы проекта.
3. Railway → New Project → Deploy from GitHub.
4. В Variables добавь:

```env
BOT_TOKEN=
ADMIN_CHAT_ID=
SHEETS_WEBAPP_URL=
SHEETS_API_SECRET=
TEST_MODE=true
ALLOW_TEST_COMMANDS=true
```

## 3. Команды админа

```text
/health
/admin_reload
/admin_preview_all
/admin_preview_warmup
/admin_preview_warmup_day 7
/test_user A hot
/test_user B warm
/test_user C cold
/test_user D hot
/test_hot_followup A hot
/test_warmup_fast A hot
```

Все `/admin_*` и `/test_*` работают только для `ADMIN_CHAT_ID`.

## 4. Боевой запуск

Перед боевым запуском:

1. Удали тестовые заявки в таблице: `clearVorsovTestLeads()`
2. В Railway поставь:
   - `TEST_MODE=false`
   - `ALLOW_TEST_COMMANDS=false`
3. Проверь реальные ссылки в листе `Бот`:
   - `channel_url`
   - `booking_url`
