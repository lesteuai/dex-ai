import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['docs/**', '**/dist/**', '**/coverage/**', '**/.vite/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
