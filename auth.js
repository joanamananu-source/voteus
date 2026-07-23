(() => {
  const form = document.querySelector('[data-auth-form]');
  if (!form) return;

  const kind = form.dataset.authForm;
  const resetToken = kind === 'recovery' ? new URLSearchParams(window.location.search).get('token') : null;
  const message = form.querySelector('.message');
  const submit = form.querySelector('button[type="submit"]');
  const emailField = form.querySelector('[name="email"]');
  const passwordField = form.querySelector('[name="password"]');
  if (passwordField && kind === 'recovery') passwordField.required = Boolean(resetToken);
  if (resetToken && passwordField) {
    emailField.closest('label').style.display = 'none';
    passwordField.closest('label').style.display = 'block';
    submit.textContent = 'Set new password';
  }
  const setMessage = (text, error = false) => {
    message.textContent = text;
    message.classList.toggle('error', error);
    message.style.display = 'block';
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    const endpoint = kind === 'register' ? '/api/auth/register' : kind === 'login' ? '/api/auth/login' : resetToken ? '/api/auth/password-reset/confirm' : '/api/auth/password-reset';
    const payload = resetToken ? { token: resetToken, password: String(fields.get('password') || '') } : { email: String(fields.get('email') || '').trim() };
    if (kind === 'register') { payload.name = String(fields.get('name') || '').trim(); payload.termsAccepted = fields.get('terms') === 'on'; }
    if (kind !== 'recovery') payload.password = String(fields.get('password') || '');

    submit.disabled = true;
    const originalLabel = submit.textContent;
    submit.textContent = kind === 'recovery' ? 'Sending…' : 'Please wait…';
    message.style.display = 'none';
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to complete your request. Please try again.');
      if (kind === 'recovery') {
        setMessage(result.message || (resetToken ? 'Your password has been updated. Please log in.' : 'If an account exists, a reset link has been sent.'));
        if (resetToken) window.setTimeout(() => { window.location.href = 'login.html'; }, 900);
        return;
      }
      localStorage.setItem('voteusToken', result.token);
      localStorage.setItem('voteusUser', JSON.stringify(result.user));
      setMessage(kind === 'register' ? 'Your account is ready. Redirecting to Voteus…' : 'You are signed in. Redirecting to Voteus…');
      window.setTimeout(() => { window.location.href = 'dashboard.html'; }, 650);
    } catch (error) {
      setMessage(error.message || 'Unable to reach Voteus. Check that the server is running.', true);
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  });
})();
