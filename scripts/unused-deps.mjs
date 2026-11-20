// Lista dependencias de package.json que NINGÚN archivo de src/ importa. Uso: node scripts/unused-deps.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let code = '';
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|css)$/.test(e.name)) code += `\n${fs.readFileSync(p, 'utf8')}`;
  }
})(path.join(root, 'src'));
code += fs.readFileSync(path.join(root, 'src/main.tsx'), 'utf8');

const unused = Object.keys(pkg.dependencies).filter((n) => !code.includes(`'${n}`) && !code.includes(`"${n}`) && !code.includes(`'${n}/`) && !code.includes(`@import "${n}`));
console.log(unused.length ? unused.join('\n') : '(todas se usan)');
