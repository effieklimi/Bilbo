import { analyzeMarkdownSafely } from "../markdown/analyze";

export {
  extractTextTags,
  findTagMatches,
  isCompleteTagToken,
  normalizeTag,
  tagSearchQuery,
  type TagMatch,
} from "./syntax";

export function extractMarkdownTags(markdown: string) {
  return analyzeMarkdownSafely(markdown).tags;
}
