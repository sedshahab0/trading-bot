# انتقال پروداکشن به سرور جدید

## محتوای Git

Git شامل تمام کدهای موتور، داشبورد، فیسبوک، PM2، Nginx، وابستگی‌ها و اسکریپت‌های استقرار است.
فایل `.env.example` فهرست کامل تنظیمات production را بدون مقدارهای محرمانه نگه می‌دارد.

## خروجی runtime

روی سرور فعلی:

```bash
cd /opt/trading-bot
sudo bash deploy/export-runtime.sh
```

این دستور یک archive خصوصی با سطح دسترسی `600` می‌سازد که شامل موارد زیر است:

- فایل `.env`
- secret نشست داشبورد
- دیتابیس شبیه‌ساز و cache
- تاریخچه سیگنال و ارسال تلگرام
- صف‌ها، گروه‌ها و session فیسبوک
- state عملیاتی ربات

این archive عمداً داخل Git قرار نمی‌گیرد و باید هنگام انتقال با `scp` به سرور جدید فرستاده شود.

## راه‌اندازی سرور جدید

```bash
git clone git@github.com:sedshahab0/trading-bot.git /opt/trading-bot
cd /opt/trading-bot
sudo bash deploy/import-runtime.sh /path/to/runtime-export-*.tar.gz
sudo bash deploy/bootstrap-from-github.sh
```

پس از راه‌اندازی:

```bash
pm2 status
curl -I http://127.0.0.1:8080
```

مقادیر محرمانه نباید در commit یا history گیت قرار گیرند؛ archive انتقال باید پس از پایان مهاجرت از هر دو سرور حذف یا در فضای رمزگذاری‌شده نگهداری شود.
