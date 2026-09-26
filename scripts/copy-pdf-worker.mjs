import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const publicDir = resolve(root, 'public');
mkdirSync(publicDir, { recursive: true });
copyFileSync(
  resolve(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
  resolve(publicDir, 'pdf.worker.min.mjs'),
);
