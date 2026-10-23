const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const HASH_CHUNK_BYTES = 1024 * 1024;
const SAMPLE_CHUNK_BYTES = 64 * 1024;
const SAMPLE_BYTES = SAMPLE_CHUNK_BYTES * 3;
const DEFAULT_CONCURRENCY = 4;
const VALIDATE_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

function identityOf(stats) {
  if (stats.dev === undefined || stats.ino === undefined) return null;
  return `${stats.dev}:${stats.ino}`;
}

function snapshotOf(stats) {
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    identity: identityOf(stats)
  };
}

function sameSnapshot(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.identity === right.identity;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isUserFilePath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!isWithin(path.resolve(root), path.resolve(candidate))) return false;
  const parts = relative.toLowerCase().split(path.sep);
  const systemFolders = ['windows', 'program files', 'program files (x86)', 'programdata', 'appdata',
    '$recycle.bin', 'system volume information'];
  return !systemFolders.includes(parts[0])
    && !(parts[0] === 'users' && parts[2] === 'appdata');
}

// Walks a live folder without following symlinks or junctions and returns regular files with their size.
async function collectFiles(rootPath, { signal, onProgress = () => {}, candidatePaths, candidateFiles } = {}) {
  const files = [];
  let skippedCount = 0;
  let visitedCount = 0;
  const resolvedRoot = await fsp.realpath(path.resolve(rootPath));
  let inventoryCount;
  if (candidateFiles) {
    inventoryCount = candidateFiles.length;
    const sizeCounts = new Map();
    for (const file of candidateFiles) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(file.rawSize) || file.rawSize < 0) {
        throw new Error('Invalid file size in the duplicate scan inventory.');
      }
      sizeCounts.set(file.rawSize, (sizeCounts.get(file.rawSize) || 0) + 1);
    }
    candidatePaths = candidateFiles.filter(file => sizeCounts.get(file.rawSize) > 1).map(file => file.path);
  }
  if (candidatePaths) {
    // Same per-file checks as before, run with bounded concurrency. Results are applied in input order.
    const checkCandidate = async candidate => {
      signal?.throwIfAborted();
      const fullPath = path.resolve(candidate);
      if (!isWithin(resolvedRoot, fullPath)) return { outside: true };
      try {
        const stats = await fsp.lstat(fullPath, { bigint: true });
        const realParent = await fsp.realpath(path.dirname(fullPath));
        if (!stats.isFile() || stats.isSymbolicLink() || !isWithin(resolvedRoot, realParent)) return { skipped: true };
        return { file: { path: fullPath, ...snapshotOf(stats) } };
      } catch {
        return { skipped: true };
      }
    };
    const checks = new Array(candidatePaths.length);
    await runBounded(candidatePaths.map((candidate, index) => ({ candidate, index })), VALIDATE_CONCURRENCY,
      async ({ candidate, index }) => { checks[index] = await checkCandidate(candidate); });
    for (const check of checks) {
      signal?.throwIfAborted();
      if (check.outside) {
        skippedCount++;
        continue;
      }
      if (check.file) files.push(check.file);
      else skippedCount++;
      visitedCount++;
      if (visitedCount % 500 === 0) onProgress({ stage: 'validate', filesScanned: visitedCount });
    }
    onProgress({ stage: 'validate', filesScanned: visitedCount });
    return { files, skippedCount, filesScanned: inventoryCount ?? visitedCount };
  }

  const pending = [resolvedRoot];
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    let realDirectory;
    let entries;
    try {
      const directoryStat = await fsp.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        skippedCount++;
        continue;
      }
      realDirectory = await fsp.realpath(directory);
      if (!isWithin(resolvedRoot, realDirectory)) {
        skippedCount++;
        continue;
      }
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      skippedCount++;
      continue;
    }
    try {
      if (await fsp.realpath(directory) !== realDirectory) {
        skippedCount++;
        continue;
      }
    } catch {
      skippedCount++;
      continue;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedCount++;
        continue;
      }
      if (entry.isDirectory()) {
        try {
          const directoryStat = await fsp.lstat(fullPath);
          const childRealPath = await fsp.realpath(fullPath);
          if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && isWithin(resolvedRoot, childRealPath)) {
            pending.push(fullPath);
          } else {
            skippedCount++;
          }
        } catch {
          skippedCount++;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = await fsp.lstat(fullPath, { bigint: true });
        const parentRealPath = await fsp.realpath(path.dirname(fullPath));
        if (!stats.isFile() || stats.isSymbolicLink() || parentRealPath !== realDirectory) {
          skippedCount++;
          continue;
        }
        files.push({ path: fullPath, ...snapshotOf(stats) });
      } catch {
        skippedCount++;
      }
      visitedCount++;
      if (visitedCount % 500 === 0) onProgress({ stage: 'scan', filesScanned: visitedCount });
    }
  }
  onProgress({ stage: 'scan', filesScanned: visitedCount });
  return { files, skippedCount, filesScanned: visitedCount };
}

// Streams a file through SHA-256 so memory stays bounded by HASH_CHUNK_BYTES.
async function hashFile(filePath, signal, expectedSnapshot = null, { sample = false, onRead = () => {} } = {}) {
  signal?.throwIfAborted();
  const handle = await fsp.open(filePath, 'r');
  let stream;
  let onAbort;
  try {
    const before = await handle.stat({ bigint: true });
    const beforeSnapshot = snapshotOf(before);
    const pathBefore = await fsp.lstat(filePath, { bigint: true });
    if (!before.isFile() || pathBefore.isSymbolicLink() || !pathBefore.isFile()
      || !sameSnapshot(beforeSnapshot, snapshotOf(pathBefore))
      || (expectedSnapshot && !sameSnapshot(expectedSnapshot, beforeSnapshot))) {
      throw Object.assign(new Error('File changed before it could be verified.'), { code: 'DUPLICATE_CHANGED' });
    }

    const hash = crypto.createHash('sha256');
    if (sample) {
      const size = beforeSnapshot.size;
      const length = Math.min(SAMPLE_CHUNK_BYTES, size);
      const offsets = [...new Set([0, Math.floor((size - length) / 2), size - length])];
      const buffer = Buffer.alloc(length);
      for (const offset of offsets) {
        let read = 0;
        while (read < length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
          if (!bytesRead) {
            throw Object.assign(new Error('File changed while sampling.'), { code: 'DUPLICATE_CHANGED' });
          }
          onRead(bytesRead);
          read += bytesRead;
        }
        hash.update(buffer);
      }
    } else if (beforeSnapshot.size <= HASH_CHUNK_BYTES) {
      // A file that fits in one chunk is read with one positional read instead of creating a stream.
      // The before/after size, mtime and identity checks below still catch any change during the read.
      const size = beforeSnapshot.size;
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, read, size - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      onRead(read);
      hash.update(buffer.subarray(0, read));
    } else {
      stream = handle.createReadStream({ autoClose: false, highWaterMark: HASH_CHUNK_BYTES });
      onAbort = () => stream.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          hash.update(chunk);
          onRead(chunk.length);
        });
        stream.once('error', reject);
        stream.once('end', resolve);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
    signal?.throwIfAborted();

    const after = snapshotOf(await handle.stat({ bigint: true }));
    const pathAfter = await fsp.lstat(filePath, { bigint: true });
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || !sameSnapshot(beforeSnapshot, after)
      || !sameSnapshot(beforeSnapshot, snapshotOf(pathAfter))) {
      throw Object.assign(new Error('File changed while its contents were being read.'), { code: 'DUPLICATE_CHANGED' });
    }
    return hash.digest('hex');
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (stream && !stream.destroyed) stream.destroy();
    await handle.close();
  }
}

// Runs tasks with at most `limit` in flight.
async function runBounded(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Re-checks a file after hashing. Anything that changed or vanished is not a confirmed duplicate.
async function verifyUnchanged(file) {
  try {
    const stats = await fsp.lstat(file.path, { bigint: true });
    return stats.isFile() && !stats.isSymbolicLink() && sameSnapshot(file, snapshotOf(stats));
  } catch {
    return false;
  }
}

async function findDuplicates(rootPath, options = {}) {
  const { signal, onProgress = () => {} } = options;
  const requestedConcurrency = Math.floor(Number(options.concurrency ?? DEFAULT_CONCURRENCY));
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.min(MAX_CONCURRENCY, Math.max(1, requestedConcurrency))
    : DEFAULT_CONCURRENCY;
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    return { success: false, error: 'A folder path is required.' };
  }

  const resolvedRoot = path.resolve(rootPath);
  try {
    const rootStat = await fsp.lstat(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { success: false, error: 'The selected path is not a regular folder.' };
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { success: false, error: `Unable to access folder: ${error.message}` };
  }

  const { files, skippedCount, filesScanned } = await collectFiles(resolvedRoot, {
    signal, onProgress, candidatePaths: options.candidatePaths, candidateFiles: options.candidateFiles
  });
  signal?.throwIfAborted();

  const bySize = new Map();
  for (const file of files) {
    const group = bySize.get(file.size) || [];
    group.push(file);
    bySize.set(file.size, group);
  }
  const candidates = [...bySize.values()].filter((group) => group.length > 1);
  const sizeCandidates = candidates.flat();

  const hashed = [];
  const unverified = [];
  const recordFailure = (file, error) => {
    if (error.name === 'AbortError') throw error;
    const reason = error.code === 'ENOENT' ? 'missing'
      : error.code === 'DUPLICATE_CHANGED' ? 'changed' : 'unreadable';
    unverified.push({ path: file.path, reason });
  };
  const sampleJobs = sizeCandidates.filter(file => file.size > SAMPLE_BYTES);
  const bySample = new Map();
  let sampled = 0;
  let sampleBytesRead = 0;
  let fullHashBytesRead = 0;
  await runBounded(sampleJobs, concurrency, async file => {
    signal?.throwIfAborted();
    try {
      const digest = await hashFile(file.path, signal, file, {
        sample: true, onRead: bytes => { sampleBytesRead += bytes; }
      });
      const key = `${file.size}:${digest}`;
      const group = bySample.get(key) || [];
      group.push(file);
      bySample.set(key, group);
    } catch (error) {
      recordFailure(file, error);
    }
    sampled++;
    onProgress({ stage: 'sample', completed: sampled, total: sampleJobs.length });
  });
  const hashJobs = [
    ...sizeCandidates.filter(file => file.size <= SAMPLE_BYTES),
    ...[...bySample.values()].filter(group => group.length > 1).flat()
  ];
  let completed = 0;
  await runBounded(hashJobs, concurrency, async (file) => {
    signal?.throwIfAborted();
    try {
      const digest = await hashFile(file.path, signal, file, {
        onRead: bytes => { fullHashBytesRead += bytes; }
      });
      if (await verifyUnchanged(file)) {
        hashed.push({ ...file, digest });
      } else {
        unverified.push({ path: file.path, reason: 'changed' });
      }
    } catch (error) {
      recordFailure(file, error);
    }
    completed++;
    onProgress({ stage: 'hash', completed, total: hashJobs.length });
  });

  const byContent = new Map();
  for (const file of hashed) {
    const key = `${file.size}:${file.digest}`;
    const group = byContent.get(key) || [];
    group.push(file);
    byContent.set(key, group);
  }

  const groups = [];
  for (const members of byContent.values()) {
    const identities = new Map();
    for (const member of members) {
      const identity = member.identity || `path:${member.path}`;
      const list = identities.get(identity) || [];
      list.push(member.path);
      identities.set(identity, list);
    }
    // Two or more paths with the same identity are hard links to one NTFS record.
    if (identities.size < 2) continue;
    const size = members[0].size;
    groups.push({
      sizeBytes: size,
      digest: members[0].digest,
      copyCount: identities.size,
      duplicateLogicalBytes: (identities.size - 1) * size,
      paths: members.map((member) => member.path).sort()
    });
  }
  groups.sort((left, right) => right.duplicateLogicalBytes - left.duplicateLogicalBytes);

  return {
    success: true,
    folderPath: resolvedRoot,
    filesScanned,
    candidateFileCount: sizeCandidates.length,
    fullHashFileCount: hashJobs.length,
    sampleBytesRead,
    fullHashBytesRead,
    skippedCount,
    unverified,
    groups,
    duplicateLogicalBytes: groups.reduce((total, group) => total + group.duplicateLogicalBytes, 0)
  };
}

module.exports = { HASH_CHUNK_BYTES, SAMPLE_CHUNK_BYTES, isUserFilePath, collectFiles, findDuplicates, hashFile, runBounded, verifyUnchanged };
