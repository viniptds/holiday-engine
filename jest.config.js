/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  cacheDirectory: '/private/tmp/claude-501/jest-cache/holiday-engine',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  // Source imports use `.js` extensions (nodenext); map them back to the `.ts` files.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
};
