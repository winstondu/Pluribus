/**
 * Candidate sources: where a tree walk gets places to start besides the roots. The
 * pipeline takes the one `settings.routing.candidateSource` names, or the
 * one injected as `CoreDependencies.candidateSource`.
 */
export {
  LEXICAL_MAX_CANDIDATES,
  LEXICAL_MIN_OF_BEST,
  LEXICAL_MIN_SHARE,
  LEXICAL_SOURCE_NAME,
  LexicalIndex,
  createLexicalCandidateSource,
  lexicalTerms,
  type LexicalDocument,
  type LexicalHit,
  type LexicalSearchOptions,
  type LexicalSourceOptions,
} from './lexical'
