import { parseIntent } from '../server/lib/query-intent.js';
for (const q of process.argv.slice(2)) {
  const t = parseIntent(q);
  console.log(q.padEnd(34), '→', JSON.stringify({ fixed: t.corrected, text: t.text, sem: t.semanticText, max: t.maxPrice, left: t.maxLeft, chips: t.understood.map((c) => c.label) }));
}
