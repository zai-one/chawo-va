// ESLint for the whole workspace (flat config). Type-aware rules catch what tsc does not: promises
// nobody awaits (the Electron 44 clipboard is async), misused async callbacks, needless casts.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/release/**', '**/e2e-shots/**', 'ts/**', 'apps/desktop/native/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['*.ts', '*.js', 'fixtures/setup/*.ts'] }, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // `async` without `await` is a fine way to return a promise (and turns a throw into a rejection).
      '@typescript-eslint/require-await': 'off',
      // Rethrowing what a catch or a worker captured is allowed; new throws must be Errors.
      '@typescript-eslint/only-throw-error': ['error', { allowRethrowing: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // `let x!: T` read by a closure before it is assigned, and `let { a, b }` with one of them reassigned, stay `let`.
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Tests read untyped JSON from servers and fake loosely typed APIs.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // React: rules of hooks plus the React Compiler's own checks (purity, refs, effects).
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    // The window is sandboxed: it talks to the system only through the preload bridge.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^(node:|electron$)', message: 'The renderer has no Node or Electron: ask main through window.chawo.' },
          { regex: '^@chawo/(core|engine)/', allowTypeImports: true, message: 'Only types from @chawo/core / @chawo/engine; runtime code stays in main.' },
        ],
      }],
    },
  },
  {
    // Plain JS: scripts, fixtures, AudioWorklets, config — no type information.
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/desktop/src/renderer/public/*.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
);
