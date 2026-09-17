const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*', 'android/*', '.expo/*', 'lint.json'] },
  {
    // Pin the tsconfig so `@/` aliases resolve even when ESLint runs from the repo root (the editor).
    settings: { 'import/resolver': { typescript: { project: `${__dirname}/tsconfig.json` } } },
  },
  {
    rules: {
      // An HTML-escaping rule. React Native <Text> has no HTML parser, so an
      // apostrophe in copy is just an apostrophe — escaping it here only makes the
      // strings harder to read and proofread.
      'react/no-unescaped-entities': 'off',

      // The React Compiler rules describe real code-quality problems, but the app
      // predates them by a long way. Left as warnings so new code gets the signal
      // without the existing backlog blocking `npm run verify`; clearing them is
      // tracked work, not something to silence.
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
  {
    // Rendered copy uses full stops and commas, not em dashes between clauses. A lone
    // dash as an empty-value placeholder ("—", "— km") is fine.
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/features/*/components/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Literal[value=/[A-Za-z0-9.,] *— *[A-Za-z0-9]/]', message: 'Avoid em dashes between clauses in UI copy.' },
        { selector: 'TemplateElement[value.raw=/[A-Za-z0-9.,] *— *[A-Za-z0-9]/]', message: 'Avoid em dashes between clauses in UI copy.' },
        { selector: 'JSXText[value=/[A-Za-z0-9.,] *— *[A-Za-z0-9]/]', message: 'Avoid em dashes between clauses in UI copy.' },
      ],
    },
  },
  {
    // Build/release helpers run under Node, not Metro.
    files: ['scripts/**/*.js', 'plugins/**/*.js', '*.config.js'],
    languageOptions: { globals: { __dirname: 'readonly', module: 'writable', require: 'readonly', process: 'readonly' } },
  },
  {
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      // jest.mock() is hoisted above imports, so the mocked module's own imports
      // have to sit below the mock factory that replaces them.
      'import/first': 'off',
      // Tests re-require modules mid-file to observe fresh module state.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]);
