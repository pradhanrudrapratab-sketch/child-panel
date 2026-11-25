(function () {
  'use strict';
  var h = MK.h;
  var ERR = { discord_denied: 'Discord login was cancelled.', invalid_state: 'That login link expired. Please try again.', discord_failed: 'Discord login failed. Please try again.', discord_not_configured: 'Discord login is not enabled on this store yet.', discord_taken: 'That Discord account is already linked to another customer.' };
  MK.init('none', { title: 'Sign in' }).then(function (d) {
    if (!d) return;
    if (MK.customer) { location.href = '/account'; return; }
    var q = new URLSearchParams(location.search).get('error');
    if (q) MK.$('loginError').appendChild(h('div', { class: 'alert bad', text: ERR[q] || 'Login failed.' }));
    var ds = MK.$('discordSlot');
    if (d.store.discordLogin) ds.appendChild(h('a', { class: 'btn', href: '/auth/discord', text: 'Continue with Discord' }));
    else ds.appendChild(h('div', { class: 'alert', text: 'Discord login is not set up yet. Use your Minecraft account instead.' }));
    if (!d.store.serverConnected) MK.$('mcSlot').appendChild(h('div', { class: 'alert warn', text: 'The Minecraft server is not connected yet, so Minecraft login is unavailable.' }));
    else MK.mcChallenge(MK.$('mcSlot'), function () { setTimeout(function () { location.href = '/account'; }, 600); });
  });
})();
