(function (root) {
  const OPERATORS = ['>=', '<=', '>', '<'];
  const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  const SIZE_VALUE = /^\d+(?:\.\d+)?$/;
  const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
  const FILTER_TOKEN = /^(size:(>=|<=|>|<)\d+(?:\.\d+)?(?:b|kb|mb|gb|tb)?|modified:(>=|<=|>|<)\d{4}-\d{2}-\d{2})$/i;

  function buildFilterToken(kind, operator, value, unit) {
    if (!OPERATORS.includes(operator)) return null;
    if (kind === 'size') {
      if (!SIZE_VALUE.test(value) || !SIZE_UNITS.includes(unit)) return null;
      return `size:${operator}${value}${unit}`;
    }
    if (kind === 'modified') {
      if (!DATE_VALUE.test(value)) return null;
      return `modified:${operator}${value}`;
    }
    return null;
  }

  // Appends a token to the query, keeping the user's text untouched.
  function appendFilter(query, token) {
    const text = String(query || '').trim();
    return text ? `${text} ${token}` : token;
  }

  // Lists standalone filter tokens with their positions so chips map to exact words.
  function listFilters(query) {
    const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
    const filters = [];
    tokens.forEach((token, index) => {
      if (FILTER_TOKEN.test(token)) filters.push({ index, token, label: describe(token) });
    });
    return filters;
  }

  // Removes only the token at index, plus a NOT written immediately before it.
  function removeFilterAt(query, index) {
    const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
    if (index < 0 || index >= tokens.length || !FILTER_TOKEN.test(tokens[index])) return String(query || '');
    const start = index > 0 && tokens[index - 1] === 'NOT' ? index - 1 : index;
    tokens.splice(start, index - start + 1);
    return tokens.join(' ');
  }

  function describe(token) {
    const [kindPart, ...rest] = token.split(':');
    const value = rest.join(':');
    const operator = value.match(/^(>=|<=|>|<)/)[1];
    const amount = value.slice(operator.length);
    const kind = kindPart.toLowerCase() === 'size' ? 'Size' : 'Modified';
    return `${kind} ${operator} ${amount}`;
  }

  const api = { buildFilterToken, appendFilter, listFilters, removeFilterAt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SearchFilters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
