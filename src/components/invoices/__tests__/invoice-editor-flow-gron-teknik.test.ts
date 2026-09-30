import { describe, expect, it } from 'vitest'
import { deriveRequiresHousing } from '../invoice-editor-flow'

describe('deriveRequiresHousing: grön teknik names the property like ROT', () => {
  it('requires housing for a grön teknik line once it carries an amount', () => {
    expect(deriveRequiresHousing({ hasRotLine: false, hasGronTeknikLine: true, deductionTotal: 1875 })).toBe(true)
    expect(deriveRequiresHousing({ hasRotLine: false, hasGronTeknikLine: true, deductionTotal: 0 })).toBe(false)
    expect(deriveRequiresHousing({ hasRotLine: false, hasGronTeknikLine: false, deductionTotal: 500 })).toBe(false)
  })
})
