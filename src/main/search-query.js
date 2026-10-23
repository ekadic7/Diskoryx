const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
const FILTER_PATTERN = /^(size|modified):(>=|<=|>|<)(.+)$/i;
const SIZE_VALUE_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i;
const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const COMPARE = {
  '>': (value, target) => value > target,
  '<': (value, target) => value < target,
  '>=': (value, target) => value >= target,
  '<=': (value, target) => value <= target
};

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function nameMatcher(term) {
  const lower = term.toLowerCase();
  if (!/[*?]/.test(lower)) return name => name.toLowerCase().includes(lower);
  const pattern = new RegExp(`^${escapeRegExp(lower).replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return name => pattern.test(name.toLowerCase());
}

function parseFilter(kind, operator, value) {
  if (kind === 'size') {
    const match = SIZE_VALUE_PATTERN.exec(value);
    if (!match) return null;
    const bytes = Number(match[1]) * SIZE_UNITS[(match[2] || 'b').toLowerCase()];
    return file => file.rawSize !== undefined && COMPARE[operator](file.rawSize, bytes);
  }
  if (!DATE_VALUE_PATTERN.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return file => {
    const modified = file.date ? Date.parse(file.date) : NaN;
    return Number.isFinite(modified) && COMPARE[operator](modified, time);
  };
}

function parseTerm(token) {
  const filter = FILTER_PATTERN.exec(token);
  if (filter) {
    const matcher = parseFilter(filter[1].toLowerCase(), filter[2], filter[3]);
    if (!matcher) return { error: `Invalid ${filter[1].toLowerCase()} filter "${token}".` };
    return { matcher };
  }
  if (/^(size|modified):/i.test(token)) return { error: `Invalid filter "${token}". Use size:>10MB or modified:>=2025-01-01.` };
  return { matcher: file => nameMatcher(token)(file.name) };
}

// Syntax: terms are combined with AND; "OR" separates alternatives (AND binds tighter);
// "NOT" negates the next term. Plain words match a substring of the file name, "*" and "?" match the whole name.
// Filters: size:>10MB, size:<=500KB, modified:>=2025-01-01 (UTC, inclusive/exclusive by operator).
function parseSearchQuery(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { empty: true };

  const groups = [[]];
  let negateNext = false;
  for (const token of tokens) {
    if (token === 'OR') {
      if (negateNext || !groups.at(-1).length) return { error: 'OR needs a search term on each side.' };
      groups.push([]);
      continue;
    }
    if (token === 'AND') continue;
    if (token === 'NOT') {
      if (negateNext) return { error: 'NOT cannot be repeated.' };
      negateNext = true;
      continue;
    }
    const term = parseTerm(token);
    if (term.error) return { error: term.error };
    const matcher = negateNext ? (file => !term.matcher(file)) : term.matcher;
    negateNext = false;
    groups.at(-1).push(matcher);
  }
  if (negateNext) return { error: 'NOT needs a search term after it.' };
  if (!groups.at(-1).length) return { error: 'OR needs a search term on each side.' };

  return {
    empty: false,
    matches: file => groups.some(group => group.every(matcher => matcher(file)))
  };
}

module.exports = { parseSearchQuery };
