const cfg = window.KEON_CONFIG || {};
const payment = cfg.PAYMENT_URL || '#';
const apk = cfg.APK_URL || '#';

document.querySelectorAll('[data-payment-link]').forEach(a => {
  a.href = payment;
  if (payment !== '#') { a.target = '_blank'; a.rel = 'noopener'; }
  else a.addEventListener('click', e => { e.preventDefault(); alert('Payment setup is coming soon.'); });
});
document.querySelectorAll('[data-apk-link]').forEach(a => {
  a.href = apk;
  if (apk !== '#') { a.target = '_blank'; a.rel = 'noopener'; }
  else a.addEventListener('click', e => { e.preventDefault(); alert('KEON APK download will be added soon.'); });
});
document.getElementById('year').textContent = new Date().getFullYear();
const io = new IntersectionObserver(entries => {
  entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add('visible'); });
}, { threshold: 0.08 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));
