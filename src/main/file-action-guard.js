const fs = require('node:fs/promises');
const path = require('node:path');

function identity(stats) {
  return `${stats.dev}:${stats.ino}`;
}

async function inspectFileAction(rootPath, filePath, previous = null) {
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The selected item is outside the scanned folder.');
  }
  const chain = [];
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await fs.lstat(current, { bigint: true });
    if (stats.isSymbolicLink()) throw new Error('File actions are not allowed through links or junctions.');
    if (current !== target && !stats.isDirectory()) throw new Error('A parent folder is no longer available.');
    if (current === target && !stats.isFile() && !stats.isDirectory()) {
      throw new Error('Only regular files and folders are supported.');
    }
    chain.push({
      path: current, identity: identity(stats), inode: stats.ino.toString(),
      volume: stats.dev.toString(), isDirectory: stats.isDirectory()
    });
  }
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (realRoot.toLowerCase() !== root.toLowerCase() || realTarget.toLowerCase() !== target.toLowerCase()) {
    throw new Error('The file or scanned folder resolves through a redirected path.');
  }
  if (previous && (previous.length !== chain.length || chain.some((entry, index) =>
    entry.path !== previous[index].path || entry.identity !== previous[index].identity ||
    entry.isDirectory !== previous[index].isDirectory))) {
    throw new Error('The selected item or a parent folder changed. Scan again before using file actions.');
  }
  return chain;
}

function validateNewName(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
    value === '.' || value === '..' || value.length > 255 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(value)) {
    throw new Error('Enter a valid Windows file name without a path or reserved device name.');
  }
  return value;
}

module.exports = { inspectFileAction, validateNewName };
