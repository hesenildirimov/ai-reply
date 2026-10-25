/** Case-, spacing- and Azerbaijani-diacritic-insensitive text ("Qiymət?" matches "qiymet"). */
export function normalize(s: string): string {
  return s
    .toLocaleLowerCase('az')
    .replace(/[əä]/g, 'e').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

