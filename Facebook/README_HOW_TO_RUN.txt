━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FACEBOOK GROUP AUTO POSTER — SETUP & USAGE GUIDE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REQUIREMENTS
─────────────
- Python 3.8+  (https://python.org)
- Google Chrome installed
- Run this once to install dependencies:

    pip install selenium openpyxl webdriver-manager


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 STEP 1 — GET YOUR GROUP LIST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open script1_get_groups.py
2. Fill in:
      FB_EMAIL    = "your_email@example.com"
      FB_PASSWORD = "your_password"
3. Run it:
      python script1_get_groups.py

4. A browser window will open, log into Facebook,
   scroll through your groups, and save them to:
      fb_my_groups.xlsx

5. Open fb_my_groups.xlsx and fill in two columns:
   - Column D (Language):  English / Persian / Russian
   - Column E (Template #): 1, 2, or 3
   
   ROTATION SUGGESTION:
   - Persian groups  → Language: Persian  | rotate templates 1, 2, 3
   - Russian groups  → Language: Russian  | rotate templates 1, 2, 3
   - English groups  → Language: English  | rotate templates 1, 2, 3


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 STEP 2 — POST TO YOUR GROUPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open script2_post_to_groups.py
2. Fill in the same email/password at the top
3. Run it:
      python script2_post_to_groups.py

4. The script will:
   - Log into Facebook
   - Post to up to 10 groups per session
   - Wait 3–5 minutes between each post
   - Log every result to post_log.xlsx (✅ or ❌)
   - Skip groups already successfully posted to

5. Run it again the next day for the next batch.
   It automatically picks up where it left off.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 UPDATING THE MESSAGE (e.g. new signal)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Edit the TEMPLATES dictionary inside script2_post_to_groups.py.
Update the Entry, SL, TP values before each new campaign.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 FILES CREATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

fb_my_groups.xlsx  — your group list (edit Language + Template # here)
post_log.xlsx      — auto-generated log of every post attempt
fb_session.json    — saved login session (auto-created, do not edit)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SAFETY TIPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✔ Max 10–15 posts per day (BATCH_SIZE setting)
✔ 3–5 minute delay between posts (built in)
✔ Run at normal hours (not 2am)
✔ The script reuses your saved session so login
  attempts are minimized
✔ If Facebook asks for a CAPTCHA, complete it
  manually in the browser window — the script
  will continue automatically after

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
