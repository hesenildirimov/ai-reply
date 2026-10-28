import { normalize } from './text.js';

/**
 * Russian typed with Latin letters ("privet, skolko stoit dostavka?"), common in Azerbaijan on phones without a
 * Cyrillic keyboard. The model can mistake it for Azerbaijani; detecting it lets us tell the model to answer in
 * Russian. Deterministic word-stem scoring: Russian stems count for, distinctly Azerbaijani words count against.
 */

// Stems as they appear after normalize() (lowercase, Azerbaijani letters folded: ə→e, ş→s, ç→c...). Each stem
// of 5+ letters also matches words starting with it (shorter ones must match exactly: "cena" must not hit "cenab"). Words that also exist in Azerbaijani ("ne", "ya", "da", "magazin") are left out.
const RU_STEMS = [
  'privet',
  'zdravst',
  'zdrast',
  'dobryy',
  'dobriy',
  'dobroe',
  'skolko',
  'skolka',
  'skoko',
  'stoit',
  'stoyt',
  'tsena',
  'cena',
  'ceny',
  'nalichi',
  'dostavk',
  'dostavlya',
  'razmer',
  'khochu',
  'hochu',
  'xochu',
  'mozhno',
  'mojno',
  'nuzhn',
  'nujno',
  'nujna',
  'spasib',
  'pozhal',
  'pojal',
  'seychas',
  'sejchas',
  'sechas',
  'segodnya',
  'sevodnya',
  'zavtra',
  'ochen',
  'khorosho',
  'horosho',
  'xorosho',
  'pochemu',
  'kogda',
  'gde',
  'chto',
  'shto',
  'eto',
  'etot',
  'vas',
  'vam',
  'mne',
  'menya',
  'skidk',
  'kupit',
  'zakaz',
  'rabotaet',
  'otkryt',
  'tsvet',
  'cvet',
  'cveta',
  'chern',
  'cherniy',
  'beliy',
  'belyy',
  'krasn',
  'podskazh',
  'podskaj',
  'skazhite',
  'skajite',
  'oplat',
  'kurer',
  'nado',
  'mozhete',
  'mojete',
  'pokazh',
  'pokaj',
  'prishl',
  'ostal',
  'yest',
  'est',
  'kak',
  'ili',
  'tolko',
  'uzhe',
  'ujhe',
  'davay',
  'ladno',
  'ponyal',
  'poka',
];
const RU_STRONG = new Set(['privet', 'zdravst', 'zdrast', 'skolko', 'spasib', 'pozhal', 'pojal', 'khochu', 'hochu', 'mozhno', 'mojno', 'podskazh']);
// Exact (normalized) words that mark Azerbaijani.
const AZ_WORDS = new Set([
  'var',
  'yox',
  'nece',
  'neceye',
  'qiymet',
  'qiymeti',
  'catdirilma',
  'catdirilir',
  'unvan',
  'unvaniniz',
  'zehmet',
  'sagol',
  'sagolun',
  'olar',
  'olsun',
  'isteyirem',
  'bilerem',
  'mene',
  'sizde',
  'sizin',
  'bu',
  'men',
  'sen',
  'siz',
  'hansi',
  'harada',
  'haradadir',
  'deyil',
  'beli',
  'endirim',
  'nedir',
  'neqeder',
  'qeder',
  'ucun',
  'ile',
  've',
  'amma',
  'cox',
  'gozel',
  'sifaris',
  'olcu',
  'reng',
  'bes',
  'hele',
  'indi',
  'sabah',
  'bugun',
]);

const isRuWord = (w: string) => RU_STEMS.find((s) => w === s || (s.length >= 5 && w.startsWith(s)));

/** True when the text is Russian written in Latin letters (not Cyrillic Russian, not Azerbaijani). */
export function isLatinRussian(text: string): boolean {
  if (/\p{Script=Cyrillic}/u.test(text)) return false; // real Cyrillic: the model mirrors it anyway
  const words = normalize(text).split(' ').filter(Boolean);
  if (!words.length) return false;
  let ru = 0;
  let strong = false;
  let az = 0;
  for (const w of words) {
    if (AZ_WORDS.has(w)) az++;
    const stem = isRuWord(w);
    if (stem) {
      ru++;
      if (RU_STRONG.has(stem)) strong = true;
    }
  }
  return ru > az && (ru >= 2 || (strong && words.length <= 3));
}
