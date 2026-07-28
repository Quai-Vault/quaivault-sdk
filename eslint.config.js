import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.json' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // A library must not write to the host's console; surface information by
      // returning it or by throwing a typed error instead.
      'no-console': 'error',

      'prefer-const': 'error',
      'no-var': 'error',
      // `== null` / `!= null` is the intended idiom for "null or undefined"; requiring
      // two explicit comparisons everywhere would be noisier, not safer.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-return-await': 'error',
      'require-await': 'off',
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    // Build scripts are CLIs — reporting progress on stdout is their job.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests assert on shapes the type system cannot see and reach into internals on
    // purpose, so the two rules that exist to keep `src/` honest would only generate
    // noise here. Everything else — unused vars, `no-eval`, `prefer-const` — still applies.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.ts'],
  },
);
