"""
Opt-in Telegram Signal Broadcast Bot
=====================================
Members message the bot and press /start to opt in. You (the admin) can then
broadcast messages to everyone who opted in, segmented by tier (free/premium).

This uses Telegram's official Bot API only. No scraping, no userbot, no mass
unsolicited DMs — every recipient explicitly started a conversation with the bot.

SETUP:
1. Talk to @BotFather on Telegram, run /newbot, follow prompts, copy the token.
2. Set the environment variables below (or edit the CONFIG section).
3. pip install python-telegram-bot --break-system-packages
4. python3 signal_bot.py

ADMIN COMMANDS (only work for chat IDs in ADMIN_IDS):
  /broadcast <message>          -> sends to ALL opted-in users
  /broadcast_free <message>     -> sends to FREE tier only
  /broadcast_premium <message>  -> sends to PREMIUM tier only
  /stats                        -> shows subscriber counts
  /setpremium <user_id>         -> upgrade a user to premium tier
  /setfree <user_id>            -> downgrade a user to free tier
  /export                       -> export subscriber list as CSV

USER COMMANDS:
  /start   -> opt in, registers the user
  /stop    -> opt out, removes the user from broadcasts
"""

import os
import sqlite3
import logging
import csv
import io
from datetime import datetime

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)
from telegram.constants import ParseMode
from telegram.error import Forbidden, BadRequest

# ------------------------------------------------------------------
# CONFIG — edit these or set as environment variables
# ------------------------------------------------------------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "PUT_YOUR_BOT_TOKEN_HERE")

# Your own Telegram numeric user ID(s) — the only accounts allowed to broadcast.
# Get your ID by messaging @userinfobot on Telegram.
# Comma-separated list, e.g. ADMIN_IDS=123456789,987654321
_admin_raw = os.environ.get("ADMIN_IDS", "")
ADMIN_IDS = [int(x.strip()) for x in _admin_raw.split(",") if x.strip().isdigit()]

DB_PATH = os.environ.get("SIGNAL_BOT_DB", "subscribers.db")

WELCOME_MESSAGE = (
    "✅ Welcome to Forex TradeChi SignalBot!\n\n"
    "You'll receive trading signals, market analysis and educational content. "
    "Send /stop anytime to unsubscribe."
)

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------------
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS subscribers (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            tier TEXT DEFAULT 'free',
            joined_at TEXT,
            active INTEGER DEFAULT 1
        )
        """
    )
    conn.commit()
    conn.close()


def upsert_subscriber(user_id: int, username: str, first_name: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        INSERT INTO subscribers (user_id, username, first_name, tier, joined_at, active)
        VALUES (?, ?, ?, 'free', ?, 1)
        ON CONFLICT(user_id) DO UPDATE SET
            username=excluded.username,
            first_name=excluded.first_name,
            active=1
        """,
        (user_id, username, first_name, datetime.utcnow().isoformat()),
    )
    conn.commit()
    conn.close()


def deactivate_subscriber(user_id: int):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE subscribers SET active=0 WHERE user_id=?", (user_id,))
    conn.commit()
    conn.close()


def set_tier(user_id: int, tier: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE subscribers SET tier=? WHERE user_id=?", (tier, user_id))
    conn.commit()
    conn.close()


def get_subscribers(tier: str = None, active_only: bool = True):
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT user_id, username, first_name, tier FROM subscribers WHERE 1=1"
    params = []
    if active_only:
        query += " AND active=1"
    if tier:
        query += " AND tier=?"
        params.append(tier)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return rows


def get_stats():
    conn = sqlite3.connect(DB_PATH)
    total = conn.execute("SELECT COUNT(*) FROM subscribers WHERE active=1").fetchone()[0]
    free = conn.execute(
        "SELECT COUNT(*) FROM subscribers WHERE active=1 AND tier='free'"
    ).fetchone()[0]
    premium = conn.execute(
        "SELECT COUNT(*) FROM subscribers WHERE active=1 AND tier='premium'"
    ).fetchone()[0]
    conn.close()
    return total, free, premium


# ------------------------------------------------------------------
# HANDLERS
# ------------------------------------------------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    upsert_subscriber(user.id, user.username or "", user.first_name or "")
    await update.message.reply_text(WELCOME_MESSAGE)
    logger.info(f"New subscriber: {user.id} (@{user.username})")


async def stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    deactivate_subscriber(user.id)
    await update.message.reply_text("You've been unsubscribed. Send /start to rejoin anytime.")


def _is_admin(update: Update) -> bool:
    return update.effective_user.id in ADMIN_IDS


async def broadcast_generic(update: Update, context: ContextTypes.DEFAULT_TYPE, tier: str = None):
    if not _is_admin(update):
        await update.message.reply_text("⛔ This command is admin-only.")
        return

    text = update.message.text.split(" ", 1)
    if len(text) < 2 or not text[1].strip():
        await update.message.reply_text("Usage: /broadcast <your message>")
        return

    message = text[1].strip()
    subscribers = get_subscribers(tier=tier)

    if not subscribers:
        await update.message.reply_text("No subscribers to send to yet.")
        return

    sent, failed = 0, 0
    status_msg = await update.message.reply_text(
        f"Sending to {len(subscribers)} subscribers..."
    )

    for user_id, username, first_name, user_tier in subscribers:
        try:
            await context.bot.send_message(
                chat_id=user_id, text=message, parse_mode=ParseMode.HTML
            )
            sent += 1
        except Forbidden:
            # User blocked the bot — mark inactive so we stop retrying
            deactivate_subscriber(user_id)
            failed += 1
        except BadRequest as e:
            logger.warning(f"Failed to send to {user_id}: {e}")
            failed += 1

    await status_msg.edit_text(f"✅ Broadcast complete. Sent: {sent} | Failed/blocked: {failed}")


async def broadcast_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await broadcast_generic(update, context, tier=None)


async def broadcast_free(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await broadcast_generic(update, context, tier="free")


async def broadcast_premium(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await broadcast_generic(update, context, tier="premium")


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("⛔ This command is admin-only.")
        return
    total, free, premium = get_stats()
    await update.message.reply_text(
        f"📊 Subscribers\nTotal: {total}\nFree: {free}\nPremium: {premium}"
    )


async def set_premium(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("⛔ This command is admin-only.")
        return
    args = context.args
    if not args or not args[0].isdigit():
        await update.message.reply_text("Usage: /setpremium <user_id>")
        return
    set_tier(int(args[0]), "premium")
    await update.message.reply_text(f"User {args[0]} upgraded to premium.")


async def set_free(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("⛔ This command is admin-only.")
        return
    args = context.args
    if not args or not args[0].isdigit():
        await update.message.reply_text("Usage: /setfree <user_id>")
        return
    set_tier(int(args[0]), "free")
    await update.message.reply_text(f"User {args[0]} set to free tier.")


async def export_csv(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("⛔ This command is admin-only.")
        return
    subscribers = get_subscribers(active_only=True)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["user_id", "username", "first_name", "tier"])
    writer.writerows(subscribers)
    buf.seek(0)
    await update.message.reply_document(
        document=io.BytesIO(buf.getvalue().encode()), filename="subscribers.csv"
    )


async def unknown(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Silently ignore random messages from users (don't spam them back)
    pass


# ------------------------------------------------------------------
# MAIN
# ------------------------------------------------------------------
def main():
    if BOT_TOKEN == "PUT_YOUR_BOT_TOKEN_HERE":
        raise SystemExit(
            "Set BOT_TOKEN (env var or in the script) before running. "
            "Get one from @BotFather on Telegram."
        )
    if not ADMIN_IDS:
        logger.warning(
            "No ADMIN_IDS set — nobody will be able to use /broadcast. "
            "Set ADMIN_IDS env var to your numeric Telegram user ID."
        )

    init_db()

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("stop", stop))
    app.add_handler(CommandHandler("broadcast", broadcast_all))
    app.add_handler(CommandHandler("broadcast_free", broadcast_free))
    app.add_handler(CommandHandler("broadcast_premium", broadcast_premium))
    app.add_handler(CommandHandler("stats", stats))
    app.add_handler(CommandHandler("setpremium", set_premium))
    app.add_handler(CommandHandler("setfree", set_free))
    app.add_handler(CommandHandler("export", export_csv))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, unknown))

    logger.info("Bot starting (polling mode)...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
