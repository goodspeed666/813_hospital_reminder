import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = ['options.js', 'popup.js'];
const problems = [];
for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const match of source.matchAll(/\.innerHTML\s*=\s*([\s\S]*?);/g)) {
    const expression = match[1].trim();
    const isStaticText =
      /^(['"])(?:\\.|(?!\1)[\s\S])*\1$/.test(expression) ||
      /^`[^$]*`$/.test(expression);
    if (!isStaticText) problems.push(`${file}: ${expression.slice(0, 70).replace(/\s+/g, ' ')}`);
  }
}

assert.deepEqual(problems, [], 'rendered HTML is static; variable content should use DOM nodes and textContent');
console.log('Dynamic extension UI text uses safe DOM APIs ✅');
