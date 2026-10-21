const SORT_YIELD_INTERVAL = 16384;
const ARRAY_YIELD_INTERVAL = 64;
const MAX_CACHED_SORT_ORDERS = 2;
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
const sortOrderCache = new WeakMap();

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function compareTreeItems(leftItem, rightItem, sortType) {
  if (leftItem.type !== rightItem.type) return leftItem.type === 'folder' ? -1 : 1;
  if (sortType === 'size') return rightItem.rawSize - leftItem.rawSize;
  if (sortType === 'date') return (rightItem.date || '').localeCompare(leftItem.date || '');
  if (sortType === 'age') return (leftItem.date || '').localeCompare(rightItem.date || '');
  return NAME_COLLATOR.compare(leftItem.name, rightItem.name);
}

async function sortArrayWithoutBlocking(items, compare, isCancelled) {
  if (items.length <= 2048) {
    items.sort(compare);
    return !isCancelled();
  }

  let source = items.slice();
  let target = new Array(items.length);
  let operationsSinceYield = 0;

  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + width * 2, source.length);
      let leftIndex = start;
      let rightIndex = middle;
      let outputIndex = start;

      while (leftIndex < middle && rightIndex < end) {
        target[outputIndex++] = compare(source[leftIndex], source[rightIndex]) <= 0
          ? source[leftIndex++]
          : source[rightIndex++];
        operationsSinceYield++;
        if (operationsSinceYield >= SORT_YIELD_INTERVAL) {
          operationsSinceYield = 0;
          await yieldToUi();
          if (isCancelled()) return false;
        }
      }

      while (leftIndex < middle) target[outputIndex++] = source[leftIndex++];
      while (rightIndex < end) target[outputIndex++] = source[rightIndex++];
    }
    [source, target] = [target, source];
  }

  for (let index = 0; index < source.length; index++) {
    items[index] = source[index];
    if (index > 0 && index % SORT_YIELD_INTERVAL === 0) {
      await yieldToUi();
      if (isCancelled()) return false;
    }
  }

  return true;
}

async function sortFileTree(items, sortType, onProgress = () => {}, isCancelled = () => false) {
  const pending = [items];
  let processedArrays = 0;
  let cacheHits = 0;

  while (pending.length) {
    const currentItems = pending.pop();
    let cachedOrders = sortOrderCache.get(currentItems);
    const cachedOrder = cachedOrders?.get(sortType);

    if (cachedOrder) {
      if (isCancelled()) return false;
      for (let index = 0; index < currentItems.length; index++) currentItems[index] = cachedOrder[index];
      cachedOrders.delete(sortType);
      cachedOrders.set(sortType, cachedOrder);
      cacheHits++;
    } else {
      const sorted = await sortArrayWithoutBlocking(
        currentItems,
        (leftItem, rightItem) => compareTreeItems(leftItem, rightItem, sortType),
        isCancelled
      );
      if (!sorted) return false;

      if (!cachedOrders) {
        cachedOrders = new Map();
        sortOrderCache.set(currentItems, cachedOrders);
      }
      cachedOrders.set(sortType, currentItems.slice());
      if (cachedOrders.size > MAX_CACHED_SORT_ORDERS) {
        cachedOrders.delete(cachedOrders.keys().next().value);
      }
    }

    for (const item of currentItems) {
      if (item.type === 'folder') pending.push(item.children);
    }

    processedArrays++;
    if (processedArrays % ARRAY_YIELD_INTERVAL === 0) {
      onProgress(processedArrays, cacheHits);
      await yieldToUi();
      if (isCancelled()) return false;
    }
  }

  onProgress(processedArrays, cacheHits);
  return true;
}

async function sortItemList(items, sortType) {
  const sortedItems = items.slice();
  const completed = await sortArrayWithoutBlocking(
    sortedItems,
    (leftItem, rightItem) => compareTreeItems(leftItem, rightItem, sortType),
    () => false
  );
  return completed ? sortedItems : items;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sortFileTree, sortItemList };
} else {
  window.sortFileTree = sortFileTree;
  window.sortItemList = sortItemList;
}
