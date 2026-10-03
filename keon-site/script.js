const cfg = window.KEON_CONFIG || {};
const payment = cfg.PAYMENT_URL || '#';
const apk = cfg.APK_URL || '#';

document.querySelectorAll('[data-payment-link]').forEach(a => {
  a.href = payment;
  if (payment !== '#') {
    a.target = '_self';
  } else {
    a.addEventListener('click', e => {
      e.preventDefault();
      alert('Secure payment is not connected yet. Add your Stripe or PayPal checkout link first.');
    });
  }
});
document.querySelectorAll('[data-apk-link]').forEach(a => {
  a.href = apk;
  if (apk !== '#') {
    a.target = '_blank'; a.rel = 'noopener';
  } else {
    a.addEventListener('click', e => {
      e.preventDefault();
      alert('KEON APK download link has not been configured yet.');
    });
  }
});
const year = document.getElementById('year'); if(year) year.textContent = new Date().getFullYear();

const io = new IntersectionObserver(entries => {
  entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add('visible'); });
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

document.addEventListener('pointermove', e => {
  document.documentElement.style.setProperty('--mx', e.clientX + 'px');
  document.documentElement.style.setProperty('--my', e.clientY + 'px');
});

document.querySelectorAll('.magnetic').forEach(el => {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left - r.width/2) * .08;
    const y = (e.clientY - r.top - r.height/2) * .08;
    el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  });
  el.addEventListener('pointerleave', () => el.style.transform = '');
});
