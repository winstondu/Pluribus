// Set the theme class before first paint (see src/app/theme.tsx). A file, not an
// inline script, so the Content-Security-Policy in public/_headers can stay 'self'.
try {
  var t = localStorage.getItem('theme')
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  }
} catch (e) {}
