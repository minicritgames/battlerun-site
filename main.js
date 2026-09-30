(function () {
  var cfg = window.SITE_CONFIG || {};
  var form = document.getElementById('signup');
  var status = document.getElementById('status');
  var discord = document.getElementById('discord');

  if (cfg.discordInvite) {
    discord.href = cfg.discordInvite;
    discord.hidden = false;
  }

  var src = new URLSearchParams(location.search).get('src') || 'direct';
  form.elements.source.value = src.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'direct';

  var errors = {
    invalid_email: 'That email doesn’t look right. Please check it and try again.',
    busy: 'We’re a little busy. Please try again in a moment.',
  };

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = form.elements.email;
    if (!email.checkValidity()) {
      status.textContent = errors.invalid_email;
      email.focus();
      return;
    }
    if (!cfg.signupEndpoint) {
      status.textContent = 'Signups aren’t open yet. Please check back soon.';
      return;
    }
    var button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Signing you up…';

    // URLSearchParams body = application/x-www-form-urlencoded = CORS "simple request" (no preflight).
    // Do NOT add custom headers or a JSON content type; Apps Script can't answer preflight requests.
    fetch(cfg.signupEndpoint, { method: 'POST', body: new URLSearchParams(new FormData(form)) })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          form.hidden = true;
          status.textContent = cfg.successMessage;
        } else {
          status.textContent = errors[data.error] || 'Something went wrong. Please try again.';
          button.disabled = false;
        }
      })
      .catch(function () {
        status.textContent = 'Couldn’t reach the server. Check your connection and try again.';
        button.disabled = false;
      });
  });
})();
