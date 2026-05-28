import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.99.3',
  launchArgs: ['--no-sandbox', '--disable-chromium-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox'],
  env: {
    ELECTRON_DISABLE_SANDBOX: '1'
  }
});
