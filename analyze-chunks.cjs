const path = require('path');
async function main() {
  const { build } = await import('vite');
  const result = await build({
    configFile: path.resolve('./vite.config.ts'),
    logLevel: 'warn',
    build: { write: false },
  });
  // Check import relationships between vendor chunks
  for (const c of result.output) {
    if (c.type === 'chunk' && c.name && c.name.startsWith('vendor')) {
      console.log(c.name + ' imports:', c.imports.filter(i => i.includes('vendor')).join(', ') || 'none');
    }
  }
}
main().catch(e => console.error(e.message));
