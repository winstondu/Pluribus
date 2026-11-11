/**
 * Holds core's in-memory fakes to the same contract as the real stores: the
 * port suites that run against the IndexedDB and in-memory adapters run here
 * against `MemoryEventStore`, `MemoryProjectionCache` and `MemorySecretsStore`
 * from `@committee/core/testing`, so a core test that passes on the fakes
 * says something about the stores the app uses.
 */
import { MemoryEventStore, MemoryProjectionCache, MemorySecretsStore } from '@committee/core/testing'
import { describeEventStore, describeProjectionCache, describeSecretsStore } from './conformance'

describeEventStore('core fake MemoryEventStore', () => new MemoryEventStore())
describeProjectionCache('core fake MemoryProjectionCache', () => new MemoryProjectionCache())
describeSecretsStore('core fake MemorySecretsStore', () => new MemorySecretsStore())
