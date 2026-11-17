/**
 * @pluribus/protocol — the types and tiny pure helpers shared by the client
 * and the backend. No I/O, no dependencies.
 *
 * - ids, ulid: branded identifiers and the ULID helper
 * - model: domain value types (states, failures, placement, consumed context, elicitations)
 * - models: the tested compatibility list the answer and decomposition models are chosen from
 * - settings: user settings and their defaults
 * - events: the versioned domain events of the append-only log
 * - commands: what the client can ask for
 * - projections, patches: what the client reads, and how it is kept current
 * - backend, wire: the one interface between client and backend, and its Worker transport
 * - log-export: the full log export document and how it travels
 * - wording: the text the specification pins down
 */
export * from './ids'
export * from './ulid'
export * from './model'
export * from './models'
export * from './settings'
export * from './model-choices'
export * from './keys'
export * from './events'
export * from './commands'
export * from './projections'
export * from './patches'
export * from './backend'
export * from './wire'
export * from './log-export'
export * from './wording'
