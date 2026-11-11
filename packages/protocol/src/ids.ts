/**
 * Branded identifiers. Every entity has a stable ID (Q69). An ID is a short kind
 * prefix, an underscore, and a ULID (`msg_01JC…`), so an ID seen in a log, a
 * tooltip or the run inspector says what it names. Event IDs are bare ULIDs.
 *
 * IDs are minted by the backend only. The client never invents one: it echoes
 * IDs it received in projections back inside commands.
 */

declare const brand: unique symbol

/** A string that only type-checks where the same brand is expected. */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** 26-character Crockford base32 ULID. */
export type Ulid = Brand<string, 'Ulid'>

/** Domain event identity: a bare ULID (Q69). */
export type EventId = Brand<string, 'EventId'>

/** One conversation, with its own event log (Q70). */
export type ConversationId = Brand<string, 'ConversationId'>

/**
 * A user bubble in the transcript: either an original message exactly as
 * typed (Q3), or one split message of a sequential composite (Q53). A
 * "request" in Stop and Retry commands is a MessageId.
 */
export type MessageId = Brand<string, 'MessageId'>

/** An atomic request extracted from a composite message (glossary: Fragment). */
export type FragmentId = Brand<string, 'FragmentId'>

/**
 * The unit of work: an atomic message, or one fragment of a composite. Stable
 * across retries and revisions, so "the neighborhoods work" keeps one
 * DirectiveId while its attempts and sections accumulate.
 */
export type DirectiveId = Brand<string, 'DirectiveId'>

/** One execution of a directive. Never reused; earlier attempts stay as history. */
export type AttemptId = Brand<string, 'AttemptId'>

/** A continuing line of agent conversation with its own context ancestry and one stable color. */
export type ChainId = Brand<string, 'ChainId'>

/** A node of the genealogy: one exchange, or one join-back. */
export type NodeId = Brand<string, 'NodeId'>

/** One formation of a join-back record for a sibling group. */
export type JoinBackId = Brand<string, 'JoinBackId'>

/** Parallel forks sharing one starting context. */
export type SiblingGroupId = Brand<string, 'SiblingGroupId'>

/** One question Committee put to the user. */
export type ElicitationId = Brand<string, 'ElicitationId'>

/** One entry above the composer. */
export type QueueItemId = Brand<string, 'QueueItemId'>

/** One node of the operation graph: the work for one answer section, or one join-back. */
export type OperationId = Brand<string, 'OperationId'>

/**
 * One answer section as displayed: the slot a directive's output occupies in
 * the transcript. Retries reuse the section (Q51, Q83); a revision replacement
 * or a redo of finished work opens a new one (Q38), so a directive may own
 * several sections over time and exactly one of them is current.
 */
export type SectionId = Brand<string, 'SectionId'>

/**
 * One reply at one transcript position: a single section for an atomic
 * request, or a reply group for a composite (glossary: Reply group).
 */
export type ResponseId = Brand<string, 'ResponseId'>

/** One requirement with provenance (glossary: Shared requirement, Requirement scope). */
export type RequirementId = Brand<string, 'RequirementId'>

/** Maps each entity kind to its ID type and prefix. */
export interface IdTypes {
  conversation: ConversationId
  message: MessageId
  fragment: FragmentId
  directive: DirectiveId
  attempt: AttemptId
  chain: ChainId
  node: NodeId
  joinBack: JoinBackId
  siblingGroup: SiblingGroupId
  elicitation: ElicitationId
  queueItem: QueueItemId
  operation: OperationId
  section: SectionId
  response: ResponseId
  requirement: RequirementId
}

export type IdKind = keyof IdTypes

export const ID_PREFIX: { readonly [K in IdKind]: string } = {
  conversation: 'cnv',
  message: 'msg',
  fragment: 'frg',
  directive: 'dir',
  attempt: 'att',
  chain: 'chn',
  node: 'nod',
  joinBack: 'jbk',
  siblingGroup: 'sib',
  elicitation: 'eli',
  queueItem: 'que',
  operation: 'opr',
  section: 'sec',
  response: 'rsp',
  requirement: 'req',
}

/** Builds an entity ID from a kind and a ULID. */
export function makeId<K extends IdKind>(kind: K, ulid: Ulid): IdTypes[K] {
  return `${ID_PREFIX[kind]}_${ulid}` as IdTypes[K]
}

/**
 * Casts a string that is already known to be an ID of the given kind, for
 * example one read back from storage or written literally in a fixture.
 * Throws when the prefix does not match, so a mixed-up ID fails loudly.
 */
export function asId<K extends IdKind>(kind: K, value: string): IdTypes[K] {
  if (!value.startsWith(`${ID_PREFIX[kind]}_`)) {
    throw new Error(`Expected a ${kind} ID (${ID_PREFIX[kind]}_…), got "${value}"`)
  }
  return value as IdTypes[K]
}

/** True when `value` carries the prefix of `kind`. */
export function isId<K extends IdKind>(kind: K, value: string): value is IdTypes[K] {
  return value.startsWith(`${ID_PREFIX[kind]}_`)
}

/** Mints IDs. Core receives one as an injected port so tests are deterministic. */
export interface IdFactory {
  /** A fresh entity ID of the given kind. */
  next<K extends IdKind>(kind: K): IdTypes[K]
  /** A fresh event ID. */
  nextEventId(): EventId
}
