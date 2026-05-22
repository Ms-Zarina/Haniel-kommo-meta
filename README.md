# haniel-kommo-meta

Backend-прокладка: **Kommo CRM webhook → Meta Conversions API** для бизнес-портфеля **Haniel** (pixel/dataset `1201388924544870`).

Node.js + Express. Деплой — Render.

---

## Что делает

1. Принимает webhook от Kommo на `POST /webhook/kommo`.
2. Достаёт `lead_id`, `pipeline_id`, `status_id` из payload
   (`leads.status[0] || leads.update[0] || leads.add[0]`).
3. Маппит **composite key `pipeline_id_status_id`** → Meta `event_name`
   (см. блоки `PIPELINE 1` / `PIPELINE 2` в [server.js](server.js)).
4. Идёт в Kommo API: `GET /leads/{id}?with=contacts`, берёт первый контакт.
5. Достаёт `EMAIL` / `PHONE` из `custom_fields_values`.
6. Хешит SHA256 (после `trim().toLowerCase()`, phone дополнительно очищает от не-цифр).
7. Шлёт событие в Meta CAPI (`v20.0`, `action_source: "system_generated"`).
8. Дедуп в памяти по ключу `lead_id + composite_key + event_name`.

---

## Mapping

### PIPELINE 1 — `01 Квалификация`

| Статус Kommo | Meta event |
|---|---|
| записалась | `Lead` |
| успешно реализован | `Purchase` |

### PIPELINE 2 — `Запись 01`

> ⚠️ Если эта воронка не нужна — закомментируй блок `=== PIPELINE 2 ===` в [server.js](server.js) либо просто не задавай `BOOKING_*` env vars.

| Статус Kommo | Meta event |
|---|---|
| записана | `Schedule` |
| пришла на пробную процедуру | `QualifiedLead` |
| купила абонемент | `Purchase` |
| привела подругу | `Lead` |
| купила второй раз | `Purchase` |
| обслужить сегодня | `QualifiedLead` |

Если ни один composite key не совпал — backend пробует legacy `THINKING_STATUS_ID` / `BOOKING_STATUS_ID` / `SUCCESSFULLY_STATUS_ID` (без учёта `pipeline_id`).

---

## ENV переменные

### App
| Переменная | Описание |
|---|---|
| `PORT` | На Render не задавай — он сам поставит. |
| `PROJECT_NAME` | Имя проекта в `/health` и логах. По умолч. `haniel-kommo-meta`. |

### Meta
| Переменная | Описание |
|---|---|
| `META_PIXEL_ID` | Pixel/Dataset ID Haniel: `1201388924544870`. |
| `META_ACCESS_TOKEN` | Долгоживущий токен системного пользователя. |
| `META_TEST_EVENT_CODE` | Только для теста в Events Manager. На проде пусто. |

### Kommo
| Переменная | Описание |
|---|---|
| `KOMMO_SUBDOMAIN` | Поддомен из `https://<subdomain>.kommo.com`. |
| `KOMMO_ACCESS_TOKEN` | Long-lived token интеграции. |

### Pipeline 1 — Квалификация
| Переменная | Что это |
|---|---|
| `QUALIFICATION_PIPELINE_ID` | ID воронки `01 Квалификация`. |
| `QUALIFICATION_BOOKED_STATUS_ID` | ID статуса `записалась`. |
| `QUALIFICATION_SUCCESS_STATUS_ID` | ID статуса `успешно реализован`. |

### Pipeline 2 — Запись 01
| Переменная | Что это |
|---|---|
| `BOOKING_PIPELINE_ID` | ID воронки `Запись 01`. |
| `BOOKING_BOOKED_STATUS_ID` | `записана`. |
| `BOOKING_TRIAL_VISIT_STATUS_ID` | `пришла на пробную процедуру`. |
| `BOOKING_SUBSCRIPTION_PURCHASE_STATUS_ID` | `купила абонемент`. |
| `BOOKING_FRIEND_REFERRAL_STATUS_ID` | `привела подругу`. |
| `BOOKING_SECOND_PURCHASE_STATUS_ID` | `купила второй раз`. |
| `BOOKING_SERVE_TODAY_STATUS_ID` | `обслужить сегодня`. |

### Legacy (опционально)
`THINKING_STATUS_ID`, `BOOKING_STATUS_ID`, `SUCCESSFULLY_STATUS_ID` — старый status-only маппинг, используется как fallback.

Шаблон — см. [.env.example](.env.example).

---

## ⭐️ Как заполнить mapping (workflow)

Это **главный сценарий настройки**. Делается один раз при подключении нового Kommo.

1. Залей backend на Render (см. ниже).
2. В Render env vars пропиши пока только: `META_PIXEL_ID`, `META_ACCESS_TOKEN`, `KOMMO_SUBDOMAIN`, `KOMMO_ACCESS_TOKEN`.
3. Открой:
   ```
   GET https://<render-url>/kommo/statuses-target
   ```
   Endpoint сам найдёт воронки `Квалификация` и `Запись 01` по мягкому совпадению имени (trim + lowercase) и покажет нужные `status_id`.
4. Скопируй оттуда `pipeline_id` и `status_id` для каждого статуса.
5. Вставь их в env vars на Render (см. таблицу выше), нажми **Save, Deploy**.
6. Проверь итог:
   ```
   GET https://<render-url>/mapping
   ```
   Должен вернуть массив composite-ключей `pipeline_id_status_id → Meta event_name`.
7. Создай webhook в Kommo (см. ниже) и протестируй.

Если в `/kommo/statuses-target` для какого-то статуса `found: false` — значит, в Kommo он называется иначе. Открой `/kommo/pipelines`, найди реальное имя, либо переименуй в Kommo, либо подправь ожидаемое имя в `TARGET_PIPELINES` в [server.js](server.js).

---

## Деплой на Render

1. Запушь проект на GitHub.
2. Render → **New** → **Web Service** → подключи репозиторий.
3. Настройки:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Node version**: 18+ (из `engines` в `package.json`).
4. **Environment Variables** — добавь всё из таблиц выше **кроме `PORT`**.
5. Дождись успешного деплоя.
6. Проверь:
   ```
   GET https://<render-url>/health
   ```

> ⚠️ Free-план Render усыпляет сервис — первый webhook после простоя может ждать ~30 сек.

---

## Деплой на Vercel

Тот же код работает и на Vercel — Express-app экспортируется как serverless function через [`api/index.js`](api/index.js).
`app.listen()` запускается **только локально**: на Vercel выставлена env `VERCEL=1` и listen пропускается.

### Структура для Vercel

```
api/
  index.js         # реэкспортирует Express app из ../server.js
server.js          # вся бизнес-логика, роуты, middleware
vercel.json        # rewrites: все пути → /api/index.js
```

### Шаги

1. Запушь проект на GitHub (см. этот репозиторий).
2. https://vercel.com → **Add New → Project** → Import репозитория.
3. **Framework Preset**: Other (Vercel сам подхватит `vercel.json`).
4. Build / Output settings оставь по умолчанию — ничего не переопределять.
5. **Environment Variables** — добавь всё то же, что для Render
   (META_*, KOMMO_*, QUALIFICATION_*, BOOKING_*, опц. THINKING/BOOKING/SUCCESSFULLY_STATUS_ID).
   `PORT` и `VERCEL` **не задавай** — Vercel ставит сам.
6. Deploy → получишь URL вида `https://haniel-kommo-meta.vercel.app`.
7. Проверь:
   ```
   GET https://<vercel-url>/health
   GET https://<vercel-url>/kommo/pipelines
   GET https://<vercel-url>/mapping
   ```
8. В Kommo webhook укажи `https://<vercel-url>/webhook/kommo`.

### vercel.json

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/api/index.js" }
  ],
  "functions": {
    "api/index.js": { "maxDuration": 30 }
  }
}
```

`rewrites` перенаправляет **любой** входящий путь на единственную serverless-функцию `api/index.js`, внутри которой работает Express и сам разруливает роутинг (`/health`, `/webhook/kommo` и т.д.).

### Особенности Vercel vs Render

- **Cold start** — первый запрос после паузы может занять 1–3 сек.
- **In-memory dedupe** (`sentEvents` Set) **сбрасывается между cold-start'ами**. Для критичных дублей лучше переехать на Render (постоянный процесс) или подключить Vercel KV / Upstash Redis.
- **maxDuration**: на Hobby-плане до 60 сек, у нас стоит 30 — этого хватает на Kommo API + Meta CAPI.
- Логи смотри в **Vercel → Project → Logs** (Functions tab).

---

## Webhook в Kommo

1. **Настройки → Интеграции → Создать интеграцию → Webhooks**.
2. URL:
   ```
   https://<твой-render-url>/webhook/kommo
   ```
3. События (минимум):
   - Изменение статуса сделки
   - (опционально) Создание сделки / Изменение сделки
4. Выбери воронки `01 Квалификация` и `Запись 01`.
5. Сохрани и проверь — перетащи тестовую сделку → смотри Render Logs.

---

## Эндпоинты

### `GET /health`
Проверка готовности и наличия всех ENV (включая pipeline-mapping vars).

### `GET /kommo/pipelines`
Все воронки и статусы из Kommo (через `GET /api/v4/leads/pipelines`).
```json
{
  "ok": true,
  "count": 2,
  "pipelines": [
    {
      "pipeline_id": 123,
      "pipeline_name": "01 Квалификация",
      "statuses": [
        { "status_id": 78215430, "status_name": "записалась" },
        ...
      ]
    }
  ]
}
```

### `GET /kommo/statuses-target`
Только нужные статусы из двух целевых воронок. Поиск по имени — мягкий (`trim + lowercase`).
```json
{
  "ok": true,
  "pipelines": [
    {
      "pipeline_label": "01 Квалификация",
      "pipeline_id": 123,
      "pipeline_name_in_kommo": "01 Квалификация",
      "statuses": [
        {
          "status_name_expected": "записалась",
          "status_id": 78215430,
          "status_name_in_kommo": "Записалась",
          "found": true
        }
      ]
    }
  ]
}
```

### `GET /mapping`
Текущий резолв `pipeline_id_status_id → Meta event`. После того как заполнишь env vars — здесь увидишь все composite keys.

### `POST /webhook/test-lead`
Прямая отправка события в Meta **без обращения к Kommo API**.

**Body:**
```json
{
  "lead_id": "test_001",
  "pipeline_id": "123",
  "status_id": "78215430",
  "email": "test@example.com",
  "phone": "+420777777777"
}
```
Если `pipeline_id` опущен — попробует legacy fallback по `status_id`.

**curl:**
```bash
curl -X POST https://<render-url>/webhook/test-lead \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "test_001",
    "pipeline_id": "<QUALIFICATION_PIPELINE_ID>",
    "status_id": "<QUALIFICATION_BOOKED_STATUS_ID>",
    "email": "test@example.com",
    "phone": "+420777777777"
  }'
```

### `POST /webhook/kommo`
Реальный webhook от Kommo. Принимает `application/x-www-form-urlencoded` или JSON.

Поддерживаемые ветки payload: `leads.status[0]`, `leads.update[0]`, `leads.add[0]`.

**Ручной тест (имитация Kommo):**
```bash
curl -X POST https://<render-url>/webhook/kommo \
  -H "Content-Type: application/json" \
  -d '{
    "leads": {
      "status": [
        { "id": "123456", "pipeline_id": "<P_ID>", "status_id": "<S_ID>" }
      ]
    }
  }'
```

Ответы:
- `200 sent_to_meta: true` — событие ушло.
- `200 skipped: true` + `reason` — статус не в mapping, нет контакта, нет email/phone, дубль.
- `502` — Kommo API ошибка.
- `500` — Meta CAPI ошибка / неожиданная.

---

## Проверка в Meta Events Manager

1. Открой https://business.facebook.com/events_manager2/list/dataset/1201388924544870
2. Если `META_TEST_EVENT_CODE` заполнен → вкладка **Test Events**, события появятся за ~20 сек.
3. Без test-кода — **Overview / Diagnostics**, задержка 5–20 мин.
4. Проверь:
   - `event_name` соответствует ожидаемому.
   - `Match Quality` ок (em + ph поднимают).
   - `action_source = system_generated`.

---

## Локальный запуск

```bash
git clone git@github.com:Ms-Zarina/Haniel-kommo-meta.git
cd Haniel-kommo-meta
npm install
cp .env.example .env
# заполни значения в .env
npm start
```

Проверки:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/kommo/pipelines
curl http://localhost:3000/kommo/statuses-target
curl http://localhost:3000/mapping
```

---

## Логи

В Render → Logs пишутся:
- `[KOMMO] incoming webhook` + полный JSON payload
- `[KOMMO] detected lead { lead_id, pipeline_id, status_id, composite_key, event_name, mapping_source }`
- `[KOMMO] skipped: ...` с причиной (`composite key not mapped`, `no contact`, `no email/phone`, `duplicate`)
- `[KOMMO API] getLeadWithContacts / getContactById error`
- `[META] sending event` + `[META] response`
- `[META] error` — тело ошибки Meta
- `[TEST] incoming` для `/webhook/test-lead`

---

## Безопасность

- Никаких токенов в коде — только ENV.
- `.env` в `.gitignore`.
- Тело webhook не сохраняется кроме Render Logs.
- Дедуп — in-memory `Set` (cap 5000), очищается при перезапуске.
