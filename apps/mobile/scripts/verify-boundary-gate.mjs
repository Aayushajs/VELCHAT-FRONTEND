// Proves the §M4 layer-boundary lint actually fails on a violation (MBOOT-0 DoD).
// Writes a temp file that imports infra from the core layer (illegal per §M3/§M4),
// runs eslint on it, asserts eslint rejects it, then removes the probe.
import { writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const probe = path.join(appRoot, 'src', 'core', '__boundary_probe__.ts');

writeFileSync(
  probe,
  [
    '// TEMP probe (auto-generated). core -> infra import is a §M4 violation.',
    "import '../infra';",
    'export {};',
    '',
  ].join('\n'),
);

let caught = false;
let output = '';
try {
  execSync(`npx eslint "${probe}" --no-ignore`, {
    cwd: appRoot,
    stdio: 'pipe',
  });
} catch (e) {
  output = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
  caught = /boundaries\/element-types|boundaries/.test(output);
}
rmSync(probe, { force: true });

if (caught) {
  console.log(
    'OK  boundary gate works: a core -> infra import was rejected by eslint.',
  );
  process.exit(0);
}
console.error(
  'FAIL  boundary gate did not reject a core -> infra import.\n',
  output,
);
process.exit(1);
