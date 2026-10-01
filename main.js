(function () {
  var cfg = window.SITE_CONFIG || {};
  var form = document.getElementById('signup');
  var status = document.getElementById('status');
  var discord = document.getElementById('discord');

  if (cfg.discordInvite && discord) {
    discord.href = cfg.discordInvite;
    discord.hidden = false;
  }

  // Pages without the signup form (e.g. confirmed.html) only need the Discord button.
  if (!form) return;

  var success = document.getElementById('success');
  var successTitle = document.getElementById('success-title');
  var successMessage = document.getElementById('success-message');
  var retry = document.getElementById('retry');
  var button = form.querySelector('button');

  var src = new URLSearchParams(location.search).get('src') || 'direct';
  form.elements.source.value = src.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'direct';

  var errors = {
    invalid_email: 'That email doesn’t look right. Please check it and try again.',
    busy: 'We’re a little busy. Please try again in a moment.',
  };

  // Builds the message with the email in bold, using text nodes so the typed address is never parsed as HTML.
  function showSuccess(email) {
    var parts = (cfg.successMessage || '').split('{email}');
    successMessage.textContent = '';
    parts.forEach(function (part, i) {
      if (i > 0) {
        var strong = document.createElement('strong');
        strong.textContent = email;
        successMessage.appendChild(strong);
      }
      successMessage.appendChild(document.createTextNode(part));
    });
    successTitle.textContent = cfg.successTitle || 'Thanks!';
    status.textContent = '';
    form.hidden = true;
    success.hidden = false;
    successTitle.focus();
  }

  retry.addEventListener('click', function () {
    success.hidden = true;
    form.hidden = false;
    button.disabled = false;
    form.elements.email.focus();
    form.elements.email.select();
  });

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
    button.disabled = true;
    status.textContent = 'Signing you up…';

    // URLSearchParams body = application/x-www-form-urlencoded = CORS "simple request" (no preflight).
    // Do NOT add custom headers or a JSON content type; Apps Script can't answer preflight requests.
    fetch(cfg.signupEndpoint, { method: 'POST', body: new URLSearchParams(new FormData(form)) })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          showSuccess(email.value.trim());
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
