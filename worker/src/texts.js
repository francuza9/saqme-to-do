// What the Worker says itself (reminders, the daily summary, the test notification), in the language of the person
// it is for: the phone app's own language files (public/js/lang), all of them, so nothing is loaded at run time.

import { translator, pickLang } from '../public/js/i18n.js';
import en from '../public/js/lang/en.js';
import ka from '../public/js/lang/ka.js';
import fr from '../public/js/lang/fr.js';
import es from '../public/js/lang/es.js';
import de from '../public/js/lang/de.js';

const TABLES = { en, ka, fr, es, de };
const made = new Map();

/** { lang, t, tn, rich } for a language code ('ka', 'fr-CA', '' …); English for anything the apps do not have. */
export function textsFor(code) {
  const lang = pickLang('', [code]);
  if (!made.has(lang)) made.set(lang, translator(lang, TABLES[lang]));
  return made.get(lang);
}
