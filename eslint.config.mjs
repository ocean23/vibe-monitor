import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'

// ESLint 9 flat config（迁移自旧 .eslintrc.cjs）。
// @electron-toolkit/eslint-config-ts v3 提供 typescript-eslint 的 config()/recommended。
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'out/**',
      'dist-electron/**',
      'release/**',
      'build/icon.iconset/**',
      'src/renderer/src/types/electron-api.d.ts',
      'src/main/env.d.ts',
      'src/renderer/src/env.d.ts',
      '**/*.cjs',
      '**/*.mjs'
    ]
  },
  { settings: { react: { version: 'detect' } } },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': eslintPluginReactHooks },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 与旧配置保持一致：放开 toolkit recommended 默认开启的这两条
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  eslintConfigPrettier
)
