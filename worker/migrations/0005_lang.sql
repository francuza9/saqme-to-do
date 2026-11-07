-- The language of a shared list's browser reminders (src/reminders.js): the one the person's app uses, sent with
-- its subscribe call; '' means English. Your own reminders take the synced setting `lang` instead.
ALTER TABLE share_push ADD COLUMN lang TEXT NOT NULL DEFAULT '';
