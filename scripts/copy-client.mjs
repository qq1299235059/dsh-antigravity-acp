import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const srcClientPath = path.resolve(cwd, 'src', 'client.js');
const distClientPath = path.resolve(cwd, 'dist', 'client.js');

if (!fs.existsSync(srcClientPath) || !fs.statSync(srcClientPath).isFile()) {
  throw new Error(`Missing client entrypoint: expected file at ${srcClientPath}`);
}

fs.mkdirSync(path.dirname(distClientPath), { recursive: true });
fs.copyFileSync(srcClientPath, distClientPath);
