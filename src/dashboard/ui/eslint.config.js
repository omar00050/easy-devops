import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'public/', 'node_modules/'] },
  {
    files: ['*.js', '*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // React Compiler rules. This app does not run React Compiler and its
      // patterns predate it: `refs` rejects the deliberate latest-ref writes
      // that keep socket handlers and effects from re-subscribing on every
      // render, and `set-state-in-effect` rejects the standard "seed a local
      // draft from fetched data" / "mirror a socket payload" effects. Both
      // are safe today; adopting the compiler is a separate migration.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // `const { hasPassword, ...rest }` is how the mock backup response
      // omits the secret.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
  }
);
