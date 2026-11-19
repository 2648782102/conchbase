/**
 * Node.js version gate.
 *
 * Conchbase depends on `node:sqlite` and other Node 24 runtime features, so an
 * older interpreter fails in confusing ways deep inside the process. Checking
 * at startup turns that into one clear message.
 */

export const MINIMUM_NODE_MAJOR = 24;

export interface NodeVersionCheck {
  readonly ok: boolean;
  readonly major: number | null;
  readonly required: number;
  readonly version: string;
  readonly message: string;
}

/** Reads the major version from a `24.22.2` or `v24.22.2` style string. */
export function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : null;
}

export function describeNodeRequirement(): string {
  return `Conchbase requires Node.js ${MINIMUM_NODE_MAJOR} or newer.`;
}

export function checkNodeVersion(version: string = process.versions.node): NodeVersionCheck {
  const major = parseNodeMajor(version);
  const required = MINIMUM_NODE_MAJOR;
  if (major === null) {
    return {
      ok: false,
      major: null,
      required,
      version,
      message: `Could not determine the Node.js version from "${version}". ${describeNodeRequirement()}`,
    };
  }
  if (major < required) {
    return {
      ok: false,
      major,
      required,
      version,
      message: `Node.js ${version} is too old. ${describeNodeRequirement()} Run "nvm use" or install Node ${required}.`,
    };
  }
  return {
    ok: true,
    major,
    required,
    version,
    message: `Node.js ${version} is supported.`,
  };
}

/** Exits with a readable message when the interpreter is too old. */
export function assertSupportedNode(version: string = process.versions.node): void {
  const result = checkNodeVersion(version);
  if (result.ok) return;
  process.stderr.write(`${result.message}\n`);
  process.exit(1);
}
