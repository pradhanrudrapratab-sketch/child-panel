(function () {
  'use strict';
  var h = MK.h;
  MK.get('/api/session').then(function (s) { MK.csrf = s.csrf; return MK.get('/api/setup/status'); }).then(function (st) {
    if (st.configured) { location.href = '/'; return; }
    MK.$('mainUrl').value = st.defaultMainUrl; MK.$('publicUrl').value = location.origin;
    if (!st.contractConfirmed) MK.$('setupMsg').appendChild(h('div', { class: 'alert warn', text: 'Note: the Main Panel API contract has not been confirmed in data/contract.json yet. Setup may fail until it matches your Main Panel.' }));
  });
  MK.renderFooter();
  MK.$('setupForm').addEventListener('submit', function (e) {
    e.preventDefault(); var b = MK.$('setupBtn'); b.disabled = true; MK.clear(MK.$('setupMsg'));
    MK.post('/api/setup/redeem', { mainUrl: MK.$('mainUrl').value.trim(), code: MK.$('code').value.trim(), publicUrl: MK.$('publicUrl').value.trim(), password: MK.$('pw').value, passwordConfirm: MK.$('pw2').value }).then(function (r) {
      MK.$('setupMsg').appendChild(h('div', { class: 'alert good', text: 'Connected! Admin account: ' + r.adminEmail + '. Redirecting…' }));
      setTimeout(function () { location.href = '/admin'; }, 1200);
    }).catch(function (x) { b.disabled = false; MK.$('setupMsg').appendChild(h('div', { class: 'alert bad', text: x.message })); });
  });
})();
