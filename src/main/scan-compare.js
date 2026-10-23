// Compares the file lists of two scans of the same root. Read-only: it never
// touches the filesystem. The full result is kept; the renderer reads it in
// pages, and search and sort run over the complete list, never a prefix.
const YIELD_EVERY = 5000;
const PAGE_LIMIT_MAX = 500;

function keyOf(filePath) {
  return filePath.toLowerCase();
}

async function fileMap(scan, signal) {
  const files = new Map();
  let work = 0;
  for (const file of scan.fileNodes || []) {
    if (++work % YIELD_EVERY === 0) {
      signal?.throwIfAborted();
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!file || typeof file.path !== 'string') continue;
    files.set(keyOf(file.path), {
      path: file.path,
      sizeBytes: Number.isFinite(file.rawSize) ? file.rawSize : 0,
      modified: file.date || null,
      hardLinkCount: Number.isInteger(file.hardLinkCount) ? file.hardLinkCount : 1
    });
  }
  return files;
}

// Returns the complete comparison. Nothing is dropped: the arrays hold every
// difference, and totals are computed over all of them.
async function compareScans(before, after, options = {}) {
  const signal = options.signal;
  const beforeFiles = await fileMap(before, signal);
  const afterFiles = await fileMap(after, signal);
  const added = [];
  const removed = [];
  const changed = [];
  let work = 0;

  for (const [key, file] of afterFiles) {
    if (++work % YIELD_EVERY === 0) {
      signal?.throwIfAborted();
      await new Promise(resolve => setImmediate(resolve));
    }
    const previous = beforeFiles.get(key);
    if (!previous) {
      added.push({ path: file.path, sizeBytes: file.sizeBytes, deltaBytes: file.sizeBytes, hardLinkCount: file.hardLinkCount });
    } else if (previous.sizeBytes !== file.sizeBytes || previous.modified !== file.modified) {
      changed.push({
        path: file.path,
        beforeBytes: previous.sizeBytes,
        afterBytes: file.sizeBytes,
        deltaBytes: file.sizeBytes - previous.sizeBytes,
        hardLinkCount: file.hardLinkCount
      });
    }
  }
  for (const [key, file] of beforeFiles) {
    if (++work % YIELD_EVERY === 0) {
      signal?.throwIfAborted();
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!afterFiles.has(key)) {
      removed.push({ path: file.path, sizeBytes: file.sizeBytes, deltaBytes: -file.sizeBytes, hardLinkCount: file.hardLinkCount });
    }
  }
  signal?.throwIfAborted();

  const sumDelta = rows => rows.reduce((total, row) => total + row.deltaBytes, 0);
  const hardLinkedFiles = rows => rows.filter(row => row.hardLinkCount > 1).length;
  return {
    before: {
      savedAt: before.archive?.savedAt || null,
      fileCount: beforeFiles.size,
      totalSizeBytes: before.totalSizeBytes || 0
    },
    after: {
      scannedAt: after.scanStartedAt ? new Date(after.scanStartedAt).toISOString() : null,
      fileCount: afterFiles.size,
      totalSizeBytes: after.totalSizeBytes || 0
    },
    deltaBytes: (after.totalSizeBytes || 0) - (before.totalSizeBytes || 0),
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    netAddedBytes: sumDelta(added),
    netRemovedBytes: sumDelta(removed),
    netChangedBytes: sumDelta(changed),
    hardLinks: {
      added: hardLinkedFiles(added),
      removed: hardLinkedFiles(removed),
      changed: hardLinkedFiles(changed)
    },
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    lists: { added, removed, changed }
  };
}

// Reads one page of a change list. Filtering and sorting run over the complete
// list first, so a search or sort never sees only a prefix.
function pageChanges(diff, kind, options = {}) {
  const list = diff.lists?.[kind];
  if (!list) throw new Error('Choose Added, Removed or Changed.');
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const sortBy = ['path', 'size', 'delta'].includes(options.sortBy) ? options.sortBy : 'path';
  const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = Math.min(
    Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 100,
    PAGE_LIMIT_MAX
  );
  let rows = query ? list.filter(row => row.path.toLowerCase().includes(query)) : list.slice();
  rows.sort((left, right) => {
    if (sortBy === 'size') return Math.abs(right.deltaBytes) - Math.abs(left.deltaBytes) || left.path.localeCompare(right.path);
    if (sortBy === 'delta') return right.deltaBytes - left.deltaBytes || left.path.localeCompare(right.path);
    return left.path.localeCompare(right.path);
  });
  return {
    kind,
    totalCount: rows.length,
    offset,
    limit,
    rows: rows.slice(offset, offset + limit)
  };
}

// Identity comes from the operating system: fs.stat(root).dev on Windows is the
// volume serial number. Mismatched known identities are refused. Missing
// identity (older archives) is allowed only when the user confirms, and the
// caller marks the result as not verified.
function checkSourceIdentity(archiveVolumeId, currentVolumeId) {
  const hasArchive = archiveVolumeId !== null && archiveVolumeId !== undefined;
  const hasCurrent = currentVolumeId !== null && currentVolumeId !== undefined;
  if (hasArchive && hasCurrent) {
    if (archiveVolumeId !== currentVolumeId) {
      return { ok: false, verified: true, error: 'The saved scan was taken from a different volume, so it cannot be compared with this location.' };
    }
    return { ok: true, verified: true };
  }
  return { ok: true, verified: false };
}

// Only content filters must match. Search and sort are display settings.
function filtersMatch(left, right) {
  const keys = ['includeExtensions', 'excludeExtensions', 'excludeFolderNames'];
  return keys.every(key => {
    const a = [...(left?.[key] || [])].map(String).sort().join('|');
    const b = [...(right?.[key] || [])].map(String).sort().join('|');
    return a === b;
  });
}

module.exports = { checkSourceIdentity, compareScans, filtersMatch, pageChanges, PAGE_LIMIT_MAX };
