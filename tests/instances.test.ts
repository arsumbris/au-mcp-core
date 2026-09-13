import { describe, it, expect } from 'vitest'
import { governInstances, type InstanceRow } from '../src/instances.ts'

// A match record's identity: name/hash/type_owners/claimed/inherited (schema-17 renamed
// `owners` -> `type_owners`; closure was removed at schema 6).
const identity = {
  name: 'session-log',
  hash: 'deadbeef',
  type_owners: ['au-mcp-sdk'],
  claimed: true,
  inherited: false,
}
const row = (path: string, fields: unknown = { big: 'x'.repeat(1000) }): InstanceRow => ({
  path,
  claim: ['session-log'],
  ...identity,
  fields,
})

describe('governInstances (P6-O7)', () => {
  it('defaults to an INDEX — drops fields, keeps path/claim + the schema-6 identity', () => {
    const out = governInstances([row('/a'), row('/b')])
    expect(out.count).toBe(2)
    expect(out.resolve).toBe(false)
    expect(out.instances).toEqual([
      { path: '/a', claim: ['session-log'], ...identity },
      { path: '/b', claim: ['session-log'], ...identity },
    ])
    expect(JSON.stringify(out)).not.toContain('big') // the heavy fields are gone
  })

  it('resolve:true keeps the full fields', () => {
    const out = governInstances([row('/a', { events: [1, 2, 3] })], { resolve: true })
    expect(out.resolve).toBe(true)
    expect(out.instances[0]).toEqual({
      path: '/a',
      claim: ['session-log'],
      ...identity,
      fields: { events: [1, 2, 3] },
    })
  })

  it('pages with limit/offset and reports truncation + next_offset', () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`/s${i}`))
    const first = governInstances(rows, { limit: 100, offset: 0 })
    expect(first.count).toBe(250)
    expect(first.instances).toHaveLength(100)
    expect(first.truncated).toBe(true)
    expect(first.next_offset).toBe(100)
    const last = governInstances(rows, { limit: 100, offset: 200 })
    expect(last.instances).toHaveLength(50)
    expect(last.truncated).toBe(false)
    expect(last).not.toHaveProperty('next_offset')
  })

  it('clamps a bad limit to the default and a negative offset to 0; default limit is 100', () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(`/s${i}`))
    const out = governInstances(rows, { limit: 0, offset: -5 })
    expect(out.limit).toBe(100)
    expect(out.offset).toBe(0)
    expect(out.instances).toHaveLength(100)
    expect(governInstances(rows, { limit: 9999 }).limit).toBe(500) // max
  })

  it('empty set -> count 0, no next_offset', () => {
    const out = governInstances([])
    expect(out).toMatchObject({ count: 0, instances: [], truncated: false })
    expect(out).not.toHaveProperty('next_offset')
  })

  it('surfaces instance #: docstrings (doc + field_docs) on the LIGHT index; omits when absent', () => {
    const documented: InstanceRow = {
      ...row('/step'),
      doc: 'gather the candidate surfaces',
      field_docs: { target: 'the container to open' },
    }
    const out = governInstances([documented, row('/bare')])
    // the docstrings ride the light index (no resolve needed), and the heavy fields stay dropped
    expect(out.resolve).toBe(false)
    expect(out.instances[0]).toEqual({
      path: '/step',
      claim: ['session-log'],
      ...identity,
      doc: 'gather the candidate surfaces',
      field_docs: { target: 'the container to open' },
    })
    expect(JSON.stringify(out)).not.toContain('big')
    // an undocumented match is byte-identical to before — no empty doc/field_docs keys
    expect(out.instances[1]).not.toHaveProperty('doc')
    expect(out.instances[1]).not.toHaveProperty('field_docs')
  })
})
