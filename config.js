// The only file to edit for URLs. None of these values are secret.
window.SITE_CONFIG = {
  // Apps Script web app URL ending in /exec (Deploy → Manage deployments). Never the /dev URL.
  signupEndpoint: 'https://script.google.com/macros/s/AKfycbxXH1LZfX4Gu2dXo8GxrHUXd_IjqB6ftwdKfH72mhfTTGXwvVwRK_rRLLme2_Mc5gB4/exec',
  // Leave empty to hide the Discord button.
  discordInvite: 'https://discord.gg/9mTbrPvyGF',
  // Double opt-in is on (Script Property DOUBLE_OPT_IN=true), so signups must confirm by email.
  // {email} is replaced with the address they typed, so they can spot a typo.
  // If double opt-in is ever turned off, use title "You're on the list!" and message "Thanks for playing Battlerun."
  successTitle: 'One more step: check your email',
  successMessage: 'We sent a confirmation link to {email}. Tap it to finish signing up. Not there in a minute? Check Promotions or Spam.',
};
