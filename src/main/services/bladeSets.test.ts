import { describe, expect, it } from 'vitest'
import { deriveSetNumberFromSerial } from './bladeSets'

describe('bladeSets service', () => {
  describe('deriveSetNumberFromSerial', () => {
    it('should derive 4-digit set number from standard serial string', () => {
      expect(deriveSetNumberFromSerial('A1 811 0377 0112')).toBe('0112')
      expect(deriveSetNumberFromSerial('T3 811 0404 0999')).toBe('0999')
      expect(deriveSetNumberFromSerial('811 1234 1000')).toBe('1000')
    })

    it('should return null or handle invalid inputs gracefully', () => {
      expect(deriveSetNumberFromSerial('')).toBeNull()
      expect(deriveSetNumberFromSerial('INVALID_SERIAL')).toBeNull()
    })
  })
})
