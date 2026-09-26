import { DatabaseSync } from 'node:sqlite'
import { runPersistenceConformance } from '@tanstack/ai-persistence/testkit'
import { sqlitePersistence } from '../src/server/sqlite-persistence'

// TanStack's own contract suite for persistence adapters, run against ours.
runPersistenceConformance('sqlite persistence', () => sqlitePersistence(new DatabaseSync(':memory:')), {
  skip: ['generationRuns', 'artifacts', 'blobs'],
})
