/**
 * `e2e codegen`: what `e2e run --codegen` keeps between runs, and how to get
 * rid of it.
 *
 * `clear` deletes the records under `<output>/codegen` and the generated file
 * each one names in `codegen.outDir`, then the folders that leaves empty. A
 * file no record names is never touched, so a hand-written spec kept beside
 * the generated ones stays.
 */

import path from 'node:path';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig } from '../config/resolve.ts';
import { errorMessage } from '../internal/errors.ts';
import { clearCodegen } from '../run/codegen-sync.ts';

export type CodegenCommand = 'clear';

export interface CodegenOptions {
  /** Explicit config path; the nearest `e2e.config.ts` when absent. */
  readonly config?: string;
  readonly cwd?: string;
}

/**
 * Runs one `e2e codegen` command against the project's resolved config, so
 * `output`, `codegen.outDir`, and `--config` mean here what they mean to a
 * run. Returns the process exit code: 2 for a config or filesystem error, 0
 * otherwise; nothing to clear is a fact, not a failure.
 */
export async function codegen(command: CodegenCommand, options: CodegenOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const discovered = discoverConfig(cwd, options.config);
    if (discovered.configPath === undefined) throw missingConfigError(cwd);
    const raw = await loadConfigModule(discovered.configPath);
    const config = resolveConfig(raw, { projectRoot: discovered.projectRoot, configPath: discovered.configPath, env: process.env });
    switch (command) {
      case 'clear': {
        const cleared = await clearCodegen(config);
        const where = path.relative(cwd, config.codegen.outDir) || '.';
        process.stdout.write(
          cleared.records === 0
            ? `no generated code to clear for ${where}\n`
            : `cleared ${String(cleared.files.length)} generated file(s) from ${where} and ${String(cleared.records)} record(s)\n`,
        );
        return 0;
      }
    }
  } catch (cause) {
    process.stderr.write(`${errorMessage(cause)}\n`);
    return 2;
  }
}
