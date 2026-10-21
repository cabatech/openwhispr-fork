import type { SkillSummary } from "../types/skills";

/** The lowest score a skill needs to be picked; a tie for the top picks nothing. */
export const LOCAL_SKILL_PICK_MIN_SCORE = 2;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "my",
  "me",
  "i",
  "is",
  "it",
  "this",
  "that",
  "with",
  "from",
  "please",
  "can",
  "you",
  "what",
  "when",
  "use",
  "ask",
  "asks",
  "about",
  "or",
  "be",
  "do",
  "make",
  "get",
  "after",
  "before",
]);
// One Chinese, Japanese or Korean character is a word on its own.
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

function terms(text: string): Set<string> {
  const out = new Set<string>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  for (const { segment, isWordLike } of segmenter.segment(text.normalize("NFKC").toLowerCase())) {
    // Checked before the plural trim, which would turn "this" into a keyword ("thi").
    if (!isWordLike || STOPWORDS.has(segment)) continue;
    const word = segment.length > 3 && segment.endsWith("s") ? segment.slice(0, -1) : segment;
    if ((word.length < 2 && !CJK.test(word)) || STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

/**
 * For a model that can't call tools: the one skill whose words the request shares most. A
 * word in the skill's name counts 2, one in its description 1.
 */
export function pickSkillForRequest(request: string, skills: SkillSummary[]): SkillSummary | null {
  const wanted = terms(request);
  const ranked = skills
    .map((skill) => {
      const nameTerms = terms(`${skill.displayName} ${skill.name.replace(/-/g, " ")}`);
      const descriptionTerms = terms(skill.description);
      let score = 0;
      for (const word of wanted) {
        score += nameTerms.has(word) ? 2 : descriptionTerms.has(word) ? 1 : 0;
      }
      return { skill, score };
    })
    .sort((a, b) => b.score - a.score);
  const [best, next] = ranked;
  if (!best || best.score < LOCAL_SKILL_PICK_MIN_SCORE) return null;
  return next && next.score === best.score ? null : best.skill;
}
