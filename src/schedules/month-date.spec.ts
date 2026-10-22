import { addMonth } from './month-date';

test('conserva día ancla al pasar por febrero y años bisiestos', () => {
  expect(addMonth('2026-01-31', 31)).toBe('2026-02-28');
  expect(addMonth('2026-02-28', 31)).toBe('2026-03-31');
  expect(addMonth('2028-01-31', 31)).toBe('2028-02-29');
  expect(addMonth('2028-02-29', 31)).toBe('2028-03-31');
  expect(addMonth('2026-12-31', 31)).toBe('2027-01-31');
});
