import { describe, expect, it } from 'vitest';
import { parseCoordinateInput, updateCoordinateValue } from './coordinates';

describe('coordinate input behavior', () => {
  it('accepts finite decimal values and rejects non-finite text', () => {
    expect(parseCoordinateInput('77.209')).toBe(77.209);
    expect(parseCoordinateInput('-28.5')).toBe(-28.5);
    expect(parseCoordinateInput('not-a-number')).toBeNull();
    expect(parseCoordinateInput('Infinity')).toBeNull();
  });

  it('preserves the established empty-field conversion to zero', () => {
    expect(parseCoordinateInput('')).toBe(0);
    expect(parseCoordinateInput('   ')).toBe(0);
  });

  it('updates one axis without mutating the existing coordinate', () => {
    const current: [number, number] = [77.2, 28.6];
    const next = updateCoordinateValue(current, 1, '29.1');

    expect(next).toEqual([77.2, 29.1]);
    expect(next).not.toBe(current);
    expect(current).toEqual([77.2, 28.6]);
  });

  it('starts an unset coordinate at zero and ignores invalid text', () => {
    expect(updateCoordinateValue(null, 0, '77.5')).toEqual([77.5, 0]);
    const current: [number, number] = [77.2, 28.6];
    expect(updateCoordinateValue(current, 0, 'bad')).toBe(current);
    expect(updateCoordinateValue(null, 0, 'bad')).toBeNull();
  });

  it('documents that geographic range validation is not yet performed', () => {
    expect(parseCoordinateInput('181')).toBe(181);
    expect(parseCoordinateInput('-91')).toBe(-91);
  });
});
