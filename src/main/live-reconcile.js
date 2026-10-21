const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareScanMutation } = require('./scan-mutations');
const { insertCopiedItem } = require('./scan-insertion');

async function checkSmallSubtree(target, filters) {
  let count = 0;
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    const stat = await fs.lstat(current);
    if (++count > 4096) throw new Error('A changed subtree is too large for bounded live reconciliation.');
    if (stat.isSymbolicLink()) throw new Error('A changed path is a link/junction; Rescan is required.');
    if (stat.isDirectory()) {
      const entries = await fs.opendir(current);
      for await (const entry of entries) {
        if (entry.isDirectory() && filters?.excludeFolderNames?.includes(entry.name.toLowerCase())) continue;
        if (count + pending.length >= 4096) throw new Error('A changed subtree exceeds the live entry limit.');
        pending.push(path.join(current, entry.name));
      }
    } else if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Changed hard links or unsupported file types require Rescan to preserve byte ownership.');
    }
  }
}

function snapshotChanges(scan) {
  const saved = { ...scan };
  const fileLength = scan.fileNodes.length;
  const folderLength = scan.folderNodes.length;
  const folders = new Map();
  function remember(folder) {
    if (!folder || folders.has(folder)) return;
    const extensionStats = Object.fromEntries(
      Object.entries(folder.extensionStats).map(([key, value]) => [key, { ...value }])
    );
    Object.setPrototypeOf(extensionStats, Object.getPrototypeOf(folder.extensionStats));
    folders.set(folder, {
      values: { ...folder, extensionStats },
      childLength: folder.children.length
    });
  }
  return {
    record(parent, removed) {
      for (let folder = parent; folder; folder = scan.folderNodes[folder.parentFolderId]) remember(folder);
      const pending = removed?.type === 'folder' ? [removed] : [];
      while (pending.length) {
        const folder = pending.pop();
        remember(folder);
        for (const child of folder.children) if (child.type === 'folder') pending.push(child);
      }
    },
    rollback() {
      Object.assign(scan, saved);
      scan.fileNodes.length = fileLength;
      scan.folderNodes.length = folderLength;
      for (const [folder, { values, childLength }] of folders) {
        Object.assign(folder, values);
        folder.children.length = childLength;
        if (folder.folderId < folderLength) scan.folderNodes[folder.folderId] = folder;
      }
    }
  };
}

async function reconcilePaths(scan, paths, cache = {}, revision = 0, isCurrent = () => true) {
  const transaction = snapshotChanges(scan);
  try {
    return await applyPaths(scan, paths, cache, revision, isCurrent, transaction);
  } catch (error) {
    transaction.rollback();
    delete cache.members;
    throw error;
  }
}

async function applyPaths(scan, paths, cache, revision, isCurrent, transaction) {
  if (cache.scan !== scan || cache.revision !== revision || !cache.members) {
    const members = new Map();
    let work = 0;
    for (const entries of [scan.fileNodes, scan.folderNodes]) {
      for (const node of entries) {
        if (node?.path) members.set(node.path.toLowerCase(), node);
        if (++work % 16384 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    }
    Object.assign(cache, { scan, revision, members });
  }
  const members = cache.members;
  let changed = false;
  for (const target of paths.sort((a, b) => a.length - b.length)) {
    if (!isCurrent()) throw new Error('Live notifications were interrupted; the previous snapshot was retained.');
    const relative = path.relative(scan.folderPath, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('A live change is outside the scan root.');
    }
    const components = relative.split(path.sep);
    const excluded = scan.scanFilters?.excludeFolderNames || [];
    if (components.slice(0, -1).some(component => excluded.includes(component.toLowerCase()))) continue;
    let member = members.get(target.toLowerCase());
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('A live path became a link/junction; Rescan is required.');
    if (member?.type === 'folder' && stat?.isDirectory()) continue;
    if (member?.type === 'file' && stat?.isFile() &&
      member.rawSize === stat.size && member.date === stat.mtime.toISOString()) continue;
    if (member?.type === 'file' && (member.hardLinkCount > 1 || stat?.nlink > 1)) {
      throw new Error('A changed hard link requires Rescan to preserve counted byte ownership.');
    }
    if (stat) await checkSmallSubtree(target, scan.scanFilters);
    const parent = member ? scan.folderNodes[member.parentFolderId] :
      members.get(path.dirname(target).toLowerCase());
    transaction.record(parent, member);
    if (member) {
      const removed = [member];
      while (removed.length) {
        const node = removed.pop();
        members.delete(node.path.toLowerCase());
        if (node.type === 'folder') for (const child of node.children) removed.push(child);
      }
      (await prepareScanMutation(scan, member, null))();
      changed = true;
    }
    if (stat && !(stat.isDirectory() && excluded.includes(components.at(-1).toLowerCase()))) {
      const inserted = await insertCopiedItem(scan, target);
      if (!inserted) throw new Error('The changed item has an unscanned parent; Rescan is required.');
      const added = [inserted];
      while (added.length) {
        const node = added.pop();
        members.set(node.path.toLowerCase(), node);
        if (node.type === 'folder') for (const child of node.children) added.push(child);
      }
      changed = true;
    }
  }
  if (!isCurrent()) throw new Error('Live notifications were interrupted; the previous snapshot was retained.');
  return changed;
}

module.exports = { reconcilePaths, checkSmallSubtree };
