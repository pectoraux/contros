/**
 * BOQ domain — pure functions and types.
 *
 * This barrel exports the domain contract (types) and the pure deterministic
 * algorithms (normalize, match, reconcile, projection). No side effects, no DB —
 * these are fully unit-testable. Application orchestration lives in the services.
 */

export * from './types'
export * from './normalize'
export * from './match'
export * from './reconcile'
export * from './projection-contract'
export * from './projection'
export * from './xlsx-adapter-contract'
export * from './xlsx-adapter'
export * from './xlsx-serializer'
