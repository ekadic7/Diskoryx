document.getElementById('startup-message').textContent =
  new URLSearchParams(window.location.search).get('message') || 'Startup validation failed. Close and try again.';
document.getElementById('startup-close').addEventListener('click', () => window.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});
document.getElementById('startup-close').focus();
