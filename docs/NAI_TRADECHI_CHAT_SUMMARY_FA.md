# خلاصه کامل پروژه Na'ai / TradeChi Bot

> **تاریخ تهیه:** ۸ ژوئیه ۲۰۲۶  
> **منبع:** خلاصه تمام کارهای انجام‌شده در چت Cloud Agent  
> **نسخه فعلی داشبورد:** v2.10.1  
> **ریپو:** https://github.com/sedshahab0/trading-bot  
> **شاخه اصلی:** `main`

---

## ۱. سرور و محیط Production

| مورد | مقدار |
|------|--------|
| **دامنه** | https://agennews.store/ |
| **IP سرور** | `65.109.179.227` |
| **مسیر نصب** | `/opt/trading-bot/` |
| **داشبورد** | `/opt/trading-bot/dashboard/` |
| **Deploy script** | `/workspace/deploy/deploy.sh` (یا روی سرور از ریپو) |
| **ورود داشبورد** | کاربر و رمز از `.env` خوانده می‌شوند و داخل Git نگهداری نمی‌شوند. |

### فرآیندهای PM2

| نام | نقش |
|-----|-----|
| `dashboard` | Flask/Gunicorn — UI و API داشبورد |
| `signal-engine` | موتور Python — تحلیل TwelveData، ارسال Telegram/Facebook |
| `signal-server` | Flask در `Facebook/signal_server.py` — دریافت سیگنال از EA برای Facebook |

### فایل‌ها و مسیرهای مهم روی سرور

```
/opt/trading-bot/
├── .env                          # تنظیمات (SYMBOLS, MIN_SCORE, NOTIFICATIONS_PAUSED, ...)
├── run_engine.py                 # نقطه ورود موتور
├── engine/                       # منطق تحلیل Python (از v2.10.1 در git هم هست)
├── dashboard/                    # UI + server.py
├── strategy/
│   ├── active.mq5
│   ├── manifest.json
│   └── uploads/
├── Facebook/
│   ├── signal_log.txt
│   ├── signal_queue.json
│   ├── telegram_delivery.log
│   └── dashboard_audit.log
├── engine_state.json
└── SignalBot_MultiIndicator_MT5.mq5  # نسخه legacy
```

### دستور Deploy

```bash
cd /workspace && git checkout main && git pull origin main && bash deploy/deploy.sh
```

Deploy هم **dashboard** و هم **engine/** را sync می‌کند. اگر `NOTIFICATIONS_PAUSED=1` باشد، موتور restart نمی‌شود.

---

## ۲. خط زمانی نسخه‌ها (Changelog)

| نسخه | موضوع |
|------|--------|
| **v2.8.1–2.8.2** | کش سریع — enrich مشترک، bootstrap analytics، stale-while-revalidate |
| **v2.8.3** | رفع فیلدهای خالی Monitor Hero (Hostname, Uptime, Health, Bot RAM) |
| **v2.8.4** | حذف هشدار CPU/RAM/Disk از Telegram — فقط سیگنال معاملاتی |
| **v2.8.5–2.8.6** | رفع `mgmtBusy is not defined` و دکمه‌های pause/resume نوتیفیکیشن |
| **v2.8.7** | همگام‌سازی تنظیمات (Min Score, Poll) بعد از Save |
| **v2.9.0** | آپلود استراتژی `.mq5` — drag-and-drop، نسخه‌بندی، فعال‌سازی |
| **v2.10.0** | عملکرد هر نسخه استراتژی (Win Rate، سیگنال‌ها، دوره فعال) + رفع SVG Monitor |
| **v2.10.1** | رفع pause نوتیفیکیشن — engine دیگر بعد از pause دوباره start نمی‌شود |

---

## ۳. کارهای انجام‌شده در این چت (به ترتیب)

### ۳.۱ Deploy اولیه
- Pull از `main` و deploy به https://agennews.store/
- تأیید نسخه v2.9.0 روی production

### ۳.۲ صفحه Monitor — فیلدهای خالی (—)
- **علت:** تنظیم `className` روی عنصر SVG (`monitorScoreArc`) خطا می‌داد و `try/catch` خاموش، بقیه فیلدها را آپدیت نمی‌کرد.
- **رفع:** تابع `setElementClass` با `setAttribute` برای SVG + اولویت آپدیت متن قبل از SVG
- **کش:** JS `?v=21`، CSS `?v=20`
- **نکته:** بعد از deploy حتماً **Ctrl+Shift+R**

### ۳.۳ عملکرد نسخه‌های استراتژی MT5 (v2.10.0)
- **Backend:** `activation_log`، دوره‌های فعال، نسبت سیگنال‌ها به هر نسخه
- **API:** `GET /api/strategy/performance?id=<entry_id>`
- **UI Settings:** کارت مقایسه Win Rate، لیست نسخه‌ها با badge، پنل جزئیات با KPI و سیگنال‌های اخیر
- **Commit:** `dd775f6` روی `main`

### ۳.۴ توقف نوتیفیکیشن — UI pause ولی Telegram ادامه داشت (v2.10.1)
- **علت اصلی (از audit log سرور):**
  - `13:26:45` — pause notifications
  - `13:26:49` — strategy apply → **`pm2 restart signal-engine`** (۴ ثانیه بعد!)
  - `13:33:19` — engine سیگنال `GBP/USD SELL` فرستاد
- **علت دوم:** موتور Python هرگز `NOTIFICATIONS_PAUSED` را چک نمی‌کرد
- **رفع:**
  - `engine/runner.py` — خواندن pause از `.env` در هر loop
  - `engine/notifier.py` — skip Telegram/Facebook وقتی pause
  - `dashboard/server.py` — strategy apply / restart_all / start engine احترام به pause
  - `deploy/deploy.sh` — sync `engine/` + عدم restart اگر pause
- **Commit:** `f4b12ca` روی `main`

---

## ۴. APIهای مهم داشبورد

| Endpoint | کاربرد |
|----------|--------|
| `POST /api/auth/login` | ورود |
| `GET /api/bootstrap` | بارگذاری سریع اولیه |
| `GET /api/system` | CPU/RAM/Disk/Hostname/Uptime |
| `GET /api/stream` | SSE زنده |
| `POST /api/management` | pause/resume notifications، restart، ... |
| `GET/POST /api/strategy` | وضعیت استراتژی MT5 |
| `GET /api/strategy/performance?id=` | آمار Win Rate هر نسخه |
| `POST /api/strategy/upload` | آپلود `.mq5` |
| `POST /api/strategy/apply` | فعال‌سازی روی ربات |

---

## ۵. کنترل نوتیفیکیشن

### Pause (توقف نوتیفیکیشن)
1. `NOTIFICATIONS_PAUSED=1` در `.env`
2. `pm2 stop signal-engine`

### Resume (ادامه)
1. `NOTIFICATIONS_PAUSED=0`
2. `pm2 start signal-engine`

### محدودیت مهم
- **EA متاتریدر (MT5)** اگر `InpBotToken` داشته باشد، **مستقیم** به Telegram می‌فرستد — مستقل از pause داشبورد.
- Pause فقط **موتور Python روی سرور** را کنترل می‌کند.
- `signal-server` برای Facebook است، نه Telegram مستقیم.

---

## ۶. آپلود استراتژی MT5

- **Settings → استراتژی تحلیل (MT5)**
- حداکثر ۲ مگابایت، فقط `.mq5`
- فعال‌سازی: کپی به `strategy/active.mq5` + sync `MIN_SCORE` از `InpMinConfluence`
- اگر نوتیفیکیشن pause باشد: فایل ذخیره می‌شود ولی engine **restart نمی‌شود**
- نسخه فعال فعلی (زمان deploy): `SignalBot_MultiIndicator_MT5_v6.mq5` v6.00

---

## ۷. Git و شاخه‌ها

| شاخه | موضوع |
|------|--------|
| `main` | شاخه production — منبع اصلی |
| `cursor/strategy-version-stats-ba88` | v2.10.0 — merge شده |
| `cursor/fix-notification-pause-ba88` | v2.10.1 — merge شده |

**Commitهای کلیدی:**
- `87da8d3` — v2.9.0 strategy upload
- `dd775f6` — v2.10.0 version performance
- `f4b12ca` — v2.10.1 notification pause fix

---

## ۸. مشکلات شناخته‌شده / نکات

1. **کش مرورگر:** فایل‌های static تا ۲۴ ساعت cache — بعد از deploy حتماً hard refresh
2. **Monitor Hero:** اگر هنوز `—` دیدید → Ctrl+Shift+R و بررسی JS `?v=22`
3. **Engine در git:** از v2.10.1 پوشه `engine/` در ریپو است؛ قبل از آن فقط روی VPS بود
4. **PRهای draft قدیمی (#14–#16):** ممکن است obsolete باشند
5. **امنیت:** رمز admin در چت share شده — rotate کنید
6. **Phase 4 (v3.0):** PWA، i18n، paper trading — شروع نشده

---

## ۹. متغیرهای `.env` مهم

```
SYMBOLS=...
MIN_SCORE=...
POLL_SECONDS=...
NOTIFICATIONS_PAUSED=0|1
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
FACEBOOK_ENABLE=1
FACEBOOK_URL=http://127.0.0.1:5005/signal
TWELVE_DATA_API_KEY=...
STRATEGY_MQ5_PATH=/opt/trading-bot/strategy/active.mq5
ENGINE_DEBUG=0|1
```

---

## ۱۰. معماری کلی سیستم

```
[MetaTrader EA] ──WebRequest──► [signal-server :5005] ──► Facebook (script2)
       │
       └── PostToTelegram (مستقیم، اگر InpBotToken فعال باشد)

[signal-engine Python] ──► Telegram API
                      └──► signal-server (Facebook bridge)

[dashboard Flask] ──► PM2 control, .env, audit, strategy upload
                 └──► SSE /api/stream → UI
```

---

## ۱۱. کارهای باقی‌مانده (پیشنهادی)

- [ ] چرخش رمز admin داشبورد
- [ ] آپلود/مقایسه نسخه‌های بیشتر `.mq5` از طریق UI
- [ ] غیرفعال کردن Telegram در EA هنگام pause (یا فlag مشترک)
- [ ] بستن PRهای draft obsolete
- [ ] Phase 4 roadmap

---

*این فایل توسط Cloud Agent تهیه شده و در workspace پروژه ذخیره شده است.*
