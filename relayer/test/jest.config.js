module.exports = {
  testEnvironment: 'node',
  verbose: false,
  testTimeout: 120000,
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['js', 'json'],
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.[jt]sx?$',
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest'
  },
  transformIgnorePatterns: [
    // Transform p-queue and other ESM modules
    'node_modules/(?!(p-queue|uuid|eventemitter3)/)'
  ],
  moduleNameMapper: {
    '^uuid$': require.resolve('uuid'),
    '^../../client-sdk$': '<rootDir>/../test/unit/client-sdk.mock.js',
    '^../../client-sdk/index.js$': '<rootDir>/../test/unit/client-sdk.mock.js',
    '^p-queue$': '<rootDir>/../test/unit/p-queue.mock.js'
  },
  forceExit: true,
};
