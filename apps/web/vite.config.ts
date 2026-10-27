import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The studio and admin keep the session token in the browser, so the build ships a Content Security Policy that
 * lets the page run only its own scripts and talk only to the API and Bunny's upload endpoint. Even if something
 * slipped HTML into a page, it couldn't load a script or send a token anywhere else.
 */
function contentSecurityPolicy(apiUrl: string): Plugin {
  const api = new URL(apiUrl).origin;
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src 'self' ${api} https://video.bunnycdn.com`,
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'", // React's style attributes
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    plugins: [react(), contentSecurityPolicy(env.VITE_API_URL || 'http://localhost:3000')],
    server: { port: 5173 },
  };
});
