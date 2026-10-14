/* Korean particle (조사) helper — picks the form that matches the last syllable instead of showing "(으)로" / "을(를)".
 * Shared by the client and the server (server imports it like shared/project-traits.js).
 *
 *   josa('요구사항 정의', '으로') → '요구사항 정의로'      josa('분석·설계', '으로') → '분석·설계로'
 *   josa('운영', '으로')          → '운영으로'            josa('서울', '으로')    → '서울로'   (ㄹ받침 → 로)
 *   josa('목표', '을')            → '목표를'              josa('범위', '이')      → '범위가'
 * Accepted particles: 은/는 · 이/가 · 을/를 · 과/와 · 으로/로 · 이나/나 · 이라/라 (either form may be passed).
 * Non-Hangul endings: digits and Latin letters are read the Korean way (1 일 → 받침, 2 이 → none; "WBS" → 에스 → none). */
const PAIRS = [['은', '는'], ['이', '가'], ['을', '를'], ['과', '와'], ['으로', '로'], ['이나', '나'], ['이라', '라']];
const DIGIT_BATCHIM = { 0: 'ㅇ', 1: 'ㄹ', 2: '', 3: 'ㅁ', 4: '', 5: '', 6: 'ㄱ', 7: 'ㄹ', 8: 'ㄹ', 9: '' };
const LATIN_BATCHIM = new Set(['l', 'm', 'n', 'r']);   // el, em, en, ar (영어 이름은 대개 받침으로 읽힘)

/** Final consonant of the last readable character: '' (none), 'ㄹ', or another non-empty marker. */
export function finalConsonant(word) {
  const s = String(word ?? '').replace(/[\s)\]}"'’”>.,!?·…-]+$/u, '');
  const ch = s.slice(-1);
  if (!ch) return '';
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) { const jong = (code - 0xac00) % 28; return jong === 0 ? '' : jong === 8 ? 'ㄹ' : 'x'; }
  if (/\d/.test(ch)) return DIGIT_BATCHIM[ch];
  if (/[a-z]/i.test(ch)) return LATIN_BATCHIM.has(ch.toLowerCase()) ? (ch.toLowerCase() === 'l' ? 'ㄹ' : 'x') : '';
  return '';
}
export const hasBatchim = (word) => finalConsonant(word) !== '';

/** Particle form only (no word): pick('요구사항', '을') → '을'. */
export function pickJosa(word, particle) {
  const pair = PAIRS.find((p) => p.includes(particle));
  if (!pair) return particle;
  const fc = finalConsonant(word);
  if (pair[0] === '으로') return fc && fc !== 'ㄹ' ? '으로' : '로';
  return fc ? pair[0] : pair[1];
}

/** word + the matching particle. */
export const josa = (word, particle) => `${word}${pickJosa(word, particle)}`;
