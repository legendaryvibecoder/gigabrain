const MIN_NODE_MAJOR = 22;

const parseNodeVersion = (raw = '') => {
  const input = String(raw || '').trim().replace(/^v/i, '');
  const match = input.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return {
      raw: String(raw || ''),
      major: NaN,
      minor: NaN,
      patch: NaN,
      ok: false,
    };
  }
  const major = Number.parseInt(match[1] || '', 10);
  const minor = Number.parseInt(match[2] || '0', 10);
  const patch = Number.parseInt(match[3] || '0', 10);
  return {
    raw: String(raw || ''),
    major,
    minor,
    patch,
    ok: Number.isInteger(major) && major >= MIN_NODE_MAJOR,
  };
};

const describeUnsupportedNode = ({
  component = 'Gigabrain',
  binary = process.execPath,
  version = process.version,
} = {}) => {
  return [
    `${component} requires Node.js >= ${MIN_NODE_MAJOR}.x because it uses the built-in node:sqlite runtime.`,
    `Detected binary: ${String(binary || process.execPath)}`,
    `Detected version: ${String(version || process.version)}`,
    'Install or run with Node 22+ and try again.',
  ].join('\n');
};

const ensureSupportedNodeRuntime = ({
  component = 'Gigabrain',
  binary = process.execPath,
  version = process.env.GB_NODE_VERSION_OVERRIDE || process.version,
} = {}) => {
  const parsed = parseNodeVersion(version);
  if (parsed.ok) return parsed;
  const error = new Error(describeUnsupportedNode({ component, binary, version }));
  error.code = 'GB_UNSUPPORTED_NODE';
  error.minimumMajor = MIN_NODE_MAJOR;
  error.detectedVersion = String(version || '');
  throw error;
};

export {
  MIN_NODE_MAJOR,
  parseNodeVersion,
  describeUnsupportedNode,
  ensureSupportedNodeRuntime,
};
