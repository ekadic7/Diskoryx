const { formatFileSize, normalizeScanFilters } = require('./scanner');
const names = new Intl.Collator(undefined, { sensitivity: 'base' });

async function sortAnalysis(items, order) {
  const compare = order === 'size' ? (a, b) => b.rawSize - a.rawSize
    : order === 'date' ? (a, b) => (b.date || '').localeCompare(a.date || '')
      : (a, b) => names.compare(a.name, b.name);
  const block = 8192;
  for (let start = 0; start < items.length; start += block) {
    const sorted = items.slice(start, start + block).sort(compare);
    for (let index = 0; index < sorted.length; index++) items[start + index] = sorted[index];
    await new Promise(resolve => setImmediate(resolve));
  }
  let source = items;
  let target = new Array(items.length);
  for (let width = block; width < items.length; width *= 2) {
    for (let start = 0; start < items.length; start += width * 2) {
      const middle = Math.min(start + width, items.length);
      const end = Math.min(start + width * 2, items.length);
      let left = start, right = middle;
      for (let output = start; output < end; output++) {
        target[output] = left < middle && (right >= end || compare(source[left], source[right]) <= 0)
          ? source[left++] : source[right++];
        if (output % 32768 === 32767) await new Promise(resolve => setImmediate(resolve));
      }
    }
    [source, target] = [target, source];
  }
  return source;
}

async function getAnalysisPage(scan, options = {}, cache = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid analysis options.');
  const { view = 'largest', query = '', extension = '', order = 'size', offset = 0 } = options;
  if (!['largest', 'types'].includes(view) || !['size', 'name', 'date'].includes(order)) {
    throw new Error('Unsupported analysis view or order.');
  }
  if (typeof query !== 'string' || query.length > 512 || typeof extension !== 'string' || extension.length > 255) {
    throw new Error('Invalid analysis filter.');
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid analysis offset.');
  const minBytes = options.minBytes ?? 0;
  if (!Number.isFinite(minBytes) || minBytes < 0) throw new Error('Invalid minimum file size.');
  const filters = normalizeScanFilters(options.scanFilters ?? scan.scanFilters);
  const needle = query.trim().toLowerCase();
  const key = JSON.stringify([view, needle, extension.toLowerCase(), order, minBytes, filters]);
  if (cache.scan === scan && cache.key === key && cache.value) {
    return projectPage(cache.value, view, offset);
  }
  const matches = file => (!extension || file.extension === extension.toLowerCase())
    && (!filters.includeExtensions.length || filters.includeExtensions.includes(`.${file.extension}`))
    && !filters.excludeExtensions.includes(`.${file.extension}`)
    && file.rawSize >= minBytes && (!needle || file.path.toLowerCase().includes(needle));
  const files = [];
  const types = new Map();
  let totalBytes = 0;
  for (let index = 0; index < scan.fileNodes.length; index++) {
    const file = scan.fileNodes[index];
    if (matches(file)) {
      const counted = file.aggregateSize ?? file.rawSize;
      totalBytes += counted;
      if (view === 'largest') files.push(file);
      else {
        const key = file.extension;
        let group = types.get(key);
        if (!group) {
          group = { name: key === 'unknown' ? '(no extension)' : `.${key}`, extension: key,
            type: 'file', count: 0, rawSize: 0, largestBytes: 0 };
          types.set(key, group);
        }
        group.count++;
        group.rawSize += counted;
        group.largestBytes = Math.max(group.largestBytes, file.rawSize);
      }
    }
    if (index % 16384 === 16383) await new Promise(resolve => setImmediate(resolve));
  }
  const sorted = await sortAnalysis(view === 'largest' ? files : [...types.values()], order);
  const value = { sorted, totalBytes };
  cache.scan = scan;
  cache.key = key;
  cache.value = value;
  return projectPage(value, view, offset);
}

function projectPage({ sorted, totalBytes }, view, offset) {
  const items = sorted.slice(offset, offset + 100).map(item => view === 'largest' ? {
    name: item.name, path: item.path, type: 'file', extension: item.extension, date: item.date,
    parentFolderId: item.parentFolderId, rawSize: item.rawSize, size: formatFileSize(item.rawSize),
    countedSize: item.aggregateSize ?? item.rawSize, hardLinkCount: item.hardLinkCount || 1,
    isHardLinkAlias: item.sizeOwner === false
  } : {
    ...item, size: formatFileSize(item.rawSize), largest: formatFileSize(item.largestBytes),
    percent: totalBytes ? item.rawSize / totalBytes * 100 : 0
  });
  return { success: true, items, totalCount: sorted.length, offset, totalBytes, pageSize: 100 };
}

module.exports = { getAnalysisPage };
