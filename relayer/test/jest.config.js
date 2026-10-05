module.exports = {
  testEnvironment: 'node',
  verbose: false,
  reporters: ['jest-silent-reporter'],
  testTimeout: 120000,
  // Environment for the integration suites (keys, addresses, NODE_ENV=test).
  setupFiles: ['<rootDir>/setup.js'],
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
    // p-queue, uuid and eventemitter3 ship ESM entry points; transform them so
    // jest can load the real packages (no hand-written stand-ins).
    'node_modules/(?!(p-queue|uuid|eventemitter3)/)'
  ],
  moduleNameMapper: {
    '^uuid$': require.resolve('uuid')
  },
  forceExit: true,
};
