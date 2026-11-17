import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

for (const directory of ['src', 'scripts', 'tests', 'dashboard', 'extensions']) {
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.js') || name.endsWith('.ts'))) {
    execFileSync(process.execPath, ['--no-warnings', '--check', path.join(directory, file)], { stdio: 'inherit' });
  }
}
console.log('Syntax checks passed.');
