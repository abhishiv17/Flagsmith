import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Checks every skill in skills/ against the Agent Skills spec (agentskills.io/specification):
// a SKILL.md with YAML frontmatter, a name that matches the folder, and a bounded description.
const root = new URL('../../skills/', import.meta.url);
const skills = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error('no frontmatter');
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([a-z-]+):\s?(.*)$/); // top-level keys only
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

describe.each(skills)('skill %s', (dir) => {
  const md = readFileSync(new URL(`${dir}/SKILL.md`, root), 'utf8');
  const fm = frontmatter(md);

  it('has a valid name that matches its folder', () => {
    expect(fm.name).toBe(dir);
    expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm.name!.length).toBeLessThanOrEqual(64);
  });

  it('has a description of 1 to 1024 characters', () => {
    expect(fm.description?.length ?? 0).toBeGreaterThan(0);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
  });

  it('keeps optional fields within limits and the body short', () => {
    if (fm.compatibility) expect(fm.compatibility.length).toBeLessThanOrEqual(500);
    expect(md.split('\n').length).toBeLessThan(500);
  });

  it('only links reference files that exist', () => {
    for (const [, ref] of md.matchAll(/`(references\/[^`#]+)/g)) {
      expect(existsSync(new URL(`${dir}/${ref}`, root)), ref).toBe(true);
    }
  });
});
