import { normalizeSeller } from './analytics.service';

describe('normalizeSeller', () => {
  it.each([
    ['Gonzalo', 'gonzalo'],
    ['Gonzalo (Jorge)', 'gonzalo'],
    ['Gonzalo (Williams)', 'gonzalo'],
    [' Renato ', 'renato'],
    ['Ambos', 'ambos'],
  ])('normaliza %s como %s', (input, expected) => {
    expect(normalizeSeller(input)).toBe(expected);
  });
});
