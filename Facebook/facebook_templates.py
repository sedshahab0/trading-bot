"""Lightweight Facebook message templates (no Selenium)."""
import json
from pathlib import Path


def load_signal_data(signal_file):
    path = Path(signal_file)
    if not path.exists():
        raise FileNotFoundError(f"Signal file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def symbol_label(symbol, lang):
    """Return a human-readable symbol label per language."""
    labels = {
        "XAUUSD": {"English": "Gold", "Persian": "طلا", "Russian": "Золото"},
        "EURUSD": {"English": "Euro/Dollar", "Persian": "یورو/دلار", "Russian": "Евро/Доллар"},
        "GBPUSD": {"English": "Cable", "Persian": "پوند/دلار", "Russian": "Фунт/Доллар"},
        "USDJPY": {"English": "Dollar/Yen", "Persian": "دلار/ین", "Russian": "Доллар/Иена"},
        "USDCHF": {"English": "Dollar/Franc", "Persian": "دلار/فرانک", "Russian": "Доллар/Франк"},
        "AUDUSD": {"English": "Aussie", "Persian": "دلار استرالیا", "Russian": "Австралийский доллар"},
        "USDCAD": {"English": "Loonie", "Persian": "دلار کانادا", "Russian": "Канадский доллар"},
        "SILVER": {"English": "Silver", "Persian": "نقره", "Russian": "Серебро"},
        "XAGUSD":{"English": "Silver", "Persian": "نقره", "Russian": "Серебро"},
    }
    return labels.get(symbol.upper(), {}).get(lang, symbol)


def direction_label(direction, lang):
    labels = {
        "BUY":  {"English": "BUY 📈",  "Persian": "خرید (BUY) 📈", "Russian": "ПОКУПКА (BUY) 📈"},
        "SELL": {"English": "SELL 📉", "Persian": "فروش (SELL) 📉", "Russian": "ПРОДАЖА (SELL) 📉"},
    }
    return labels.get(direction.upper(), {}).get(lang, direction)


def build_templates(sig):
    """
    Build all 9 templates dynamically using live signal values.
    Templates use placeholders that are replaced with actual signal data.
    """
    sym   = sig["symbol"]
    dirn  = sig["direction"].upper()
    entry = sig["entry"]
    sl    = sig["sl"]
    tp1   = sig["tp1"]
    tp2   = sig.get("tp2", "—")
    tp3   = sig.get("tp3", "—")
    rr    = sig.get("rr", "1:3")
    basis = sig.get("basis", "SMC Structure + Liquidity Grab + Daily Bias")

    # Build TP lines — skip if "—"
    def tp_lines_en(tp1, tp2, tp3):
        lines = f"✅ TP1: {tp1}\n"
        if tp2 != "—": lines += f"✅ TP2: {tp2}\n"
        if tp3 != "—": lines += f"✅ TP3: {tp3}\n"
        return lines

    def tp_lines_fa(tp1, tp2, tp3):
        lines = f"✅ TP1: {tp1}\n"
        if tp2 != "—": lines += f"✅ TP2: {tp2}\n"
        if tp3 != "—": lines += f"✅ TP3: {tp3}\n"
        return lines

    def tp_compact_en(tp2, tp3):
        if tp2 != "—" and tp3 != "—":
            return f"{tp2} / {tp3}"
        elif tp2 != "—":
            return tp2
        return tp1

    templates = {
        # ── ENGLISH ──────────────────────────────────────────────────────
        "English": {
            "1": (
                f"🟢 LIVE SIGNAL ALERT | {sym} ({symbol_label(sym, 'English')})\n\n"
                f"📈 Direction: {direction_label(dirn, 'English')}\n"
                f"🎯 Entry: {entry}\n"
                f"🛑 Stop Loss: {sl}\n"
                f"{tp_lines_en(tp1, tp2, tp3)}\n"
                f"⚡ Risk: 1% per trade\n"
                f"📊 Basis: {basis}\n\n"
                f"💬 DM me if you want to receive signals like this daily — FREE for a limited time.\n\n"
                f"#{sym} #ForexSignals #SMC #ICT #PriceAction #Trading"
            ),
            "2": (
                f"This setup is too clean to ignore.\n\n"
                f"🟢 {sym} — {'BUY' if dirn == 'BUY' else 'SELL'} OPPORTUNITY\n\n"
                f"{'Price swept sell-side liquidity and reacted at a premium order block.' if dirn == 'BUY' else 'Price swept buy-side liquidity and reacted at a discount order block.'} "
                f"Daily bias is {'bullish' if dirn == 'BUY' else 'bearish'}.\n\n"
                f"📍 Entry: {entry}\n"
                f"🛑 SL: {sl}\n"
                f"🎯 TP: {tp_compact_en(tp2, tp3)}\n\n"
                f"RR: {rr}\n\n"
                f"Want my signals before they go public? DM me.\n\n"
                f"#{sym} #ForexSignals #SMCTrading #ICT #PriceAction"
            ),
            "3": (
                f"Members in my Telegram channel get signals like this BEFORE I post publicly.\n\n"
                f"🟢 {sym} — {direction_label(dirn, 'English')}\n\n"
                f"📍 Entry: {entry}\n"
                f"🛑 SL: {sl}\n"
                f"🎯 TP1: {tp1}"
                + (f" | TP2: {tp2}" if tp2 != "—" else "")
                + (f" | TP3: {tp3}" if tp3 != "—" else "")
                + f"\n\nRR: {rr} | Basis: {basis}\n\n"
                f"Want early access? DM me — I'll send you the details.\n\n"
                f"#{sym} #ForexSignals #SMC #ICT #Gold #Trading"
            ),
        },

        # ── PERSIAN ──────────────────────────────────────────────────────
        "Persian": {
            "1": (
                f"🟢 سیگنال زنده | {sym} ({symbol_label(sym, 'Persian')})\n\n"
                f"📈 جهت: {direction_label(dirn, 'Persian')}\n"
                f"🎯 ورود: {entry}\n"
                f"🛑 حد ضرر: {sl}\n"
                f"{tp_lines_fa(tp1, tp2, tp3)}\n"
                f"⚡ ریسک: ۱٪ از حساب\n"
                f"📊 بر اساس: {basis}\n\n"
                f"💬 اگر می‌خوای هر روز سیگنال دریافت کنی — الان بهم پیام بده. فعلاً رایگانه.\n\n"
                f"#{sym} #سیگنال_فارکس #SMC #ICT #معامله‌گری"
            ),
            "2": (
                f"این ستاپ خیلی تمیزه — نمی‌تونم نشونش ندم.\n\n"
                f"🟢 {sym} — {'فرصت خرید' if dirn == 'BUY' else 'فرصت فروش'}\n\n"
                f"{'قیمت نقدینگی رو جارو کرد و روی اوردر بلاک واکنش داد.' if dirn == 'BUY' else 'قیمت نقدینگی بالا رو جارو کرد و روی اوردر بلاک نزولی واکنش داد.'} "
                f"بایاس روزانه {'صعودیه' if dirn == 'BUY' else 'نزولیه'}.\n\n"
                f"📍 ورود: {entry}\n"
                f"🛑 SL: {sl}\n"
                f"🎯 TP: {tp_compact_en(tp2, tp3)}\n\n"
                f"نسبت ریسک به ریوارد: {rr}\n\n"
                f"می‌خوای سیگنال‌هام رو زودتر دریافت کنی؟ بهم پیام بده.\n\n"
                f"#{sym} #سیگنال_فارکس #پرایس_اکشن #SMC #ICT"
            ),
            "3": (
                f"اعضای کانال تلگرامم این سیگنال رو قبل از این پست دریافت کردن.\n\n"
                f"🟢 {sym} — {direction_label(dirn, 'Persian')}\n\n"
                f"📍 ورود: {entry}\n"
                f"🛑 SL: {sl}\n"
                f"🎯 TP1: {tp1}"
                + (f" | TP2: {tp2}" if tp2 != "—" else "")
                + (f" | TP3: {tp3}" if tp3 != "—" else "")
                + f"\n\nریوارد: {rr} | بر اساس: {basis}\n\n"
                f"می‌خوای زودتر دسترسی داشته باشی؟ بهم پیام بده.\n\n"
                f"#{sym} #سیگنال_فارکس #SMC #ICT #طلا"
            ),
        },

        # ── RUSSIAN ──────────────────────────────────────────────────────
        "Russian": {
            "1": (
                f"🟢 ЖИВОЙ СИГНАЛ | {sym} ({symbol_label(sym, 'Russian')})\n\n"
                f"📈 Направление: {direction_label(dirn, 'Russian')}\n"
                f"🎯 Вход: {entry}\n"
                f"🛑 Стоп-лосс: {sl}\n"
                f"✅ TP1: {tp1}\n"
                + (f"✅ TP2: {tp2}\n" if tp2 != "—" else "")
                + (f"✅ TP3: {tp3}\n" if tp3 != "—" else "")
                + f"\n⚡ Риск: 1% от депозита\n"
                f"📊 Основа: {basis}\n\n"
                f"💬 Напиши в личку, если хочешь получать такие сигналы каждый день — пока бесплатно.\n\n"
                f"#{sym} #СигналыФорекс #SMC #ICT #Трейдинг"
            ),
            "2": (
                f"Этот сетап слишком чистый, чтобы молчать.\n\n"
                f"🟢 {sym} — {'возможность для покупки' if dirn == 'BUY' else 'возможность для продажи'}\n\n"
                f"{'Цена сняла ликвидность снизу и показала реакцию на ордер-блоке.' if dirn == 'BUY' else 'Цена сняла ликвидность сверху и показала реакцию на медвежьем ордер-блоке.'} "
                f"Дневной байас — {'бычий' if dirn == 'BUY' else 'медвежий'}.\n\n"
                f"📍 Вход: {entry}\n"
                f"🛑 SL: {sl}\n"
                f"🎯 TP: {tp_compact_en(tp2, tp3)}\n\n"
                f"Соотношение риск/прибыль: {rr}\n\n"
                f"Хочешь получать сигналы раньше? Напиши в личку.\n\n"
                f"#{sym} #СигналыФорекс #SMCTrading #ICT #PriceAction"
            ),
            "3": (
                f"Участники моего Telegram получили этот сигнал раньше этого поста.\n\n"
                f"🟢 {sym} — {direction_label(dirn, 'Russian')}\n\n"
                f"📍 Вход: {entry}\n"
                f"🛑 SL: {sl}\n"
                f"🎯 TP1: {tp1}"
                + (f" | TP2: {tp2}" if tp2 != "—" else "")
                + (f" | TP3: {tp3}" if tp3 != "—" else "")
                + f"\n\nRR: {rr} | Основа: {basis}\n\n"
                f"Хочешь ранний доступ? Напиши мне.\n\n"
                f"#{sym} #СигналыФорекс #SMC #ICT #Золото"
            ),
        },
    }
    return templates
