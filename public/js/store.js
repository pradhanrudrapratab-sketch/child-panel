(function () {
  'use strict';
  var h = MK.h; var cat = 'all'; var D;

  function uuid() { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function colourOf(p) { return p.colour || D.store.defaultColour; }

  function card(p, i) {
    var c = colourOf(p);
    var el = h('article', { class: 'shop-card shop-card--rank is-clickable' + (p.featured ? ' is-featured' : ''), tabindex: '0', role: 'link', 'aria-label': p.name + ' - view details', style: { '--c': c.accent, '--c2': c.accent2, '--c-on': MK.onColour(c.accent), 'animation-delay': Math.min(i, 10) * 70 + 'ms' } });
    var top = h('div', { class: 'rank-top' }, h('span', { class: 'shop-index', text: String(i + 1).padStart(2, '0') }));
    var badge = p.badge || (p.featured ? 'Most popular' : (p.isBundle ? 'Bundle' : ''));
    if (badge) top.appendChild(h('span', { class: 'shop-badge', text: badge }));
    var body = h('div', { class: 'shop-body' });
    if (p.image) { var im = h('img', { class: 'shop-thumb', alt: '', src: p.image, loading: 'lazy' }); im.addEventListener('error', function () { im.remove(); }); body.appendChild(im); }
    body.appendChild(h('div', { class: 'shop-head' }, h('h3', { text: p.name })));
    body.appendChild(h('p', { class: 'shop-tag', text: p.tagline || p.description }));
    body.appendChild(h('div', { class: 'shop-price' }, h('b', { text: MK.money(p.pricePaise) }), h('span', { text: 'one-time' })));
    if (p.isBundle && p.rewards.length) body.appendChild(h('ul', { class: 'bundle-list' }, p.rewards.map(function (r) { return h('li', { text: r }); })));
    else body.appendChild(h('ul', { class: 'shop-perks' }, p.perks.map(function (t) { return h('li', { text: t }); })));
    body.appendChild(h('div', { class: 'shop-actions' }, h('button', { class: 'btn shop-cta', type: 'button', text: 'Buy now', onclick: function () { openBuy(p); } })));
    el.appendChild(top); el.appendChild(body);
    el.addEventListener('click', function (e) { if (!e.target.closest('a,button')) openBuy(p); });
    el.addEventListener('keydown', function (e) { if (!e.target.closest('a,button') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBuy(p); } });
    return el;
  }

  function openBuy(p) {
    var s = D.store, c = MK.customer, qty = 1, key = uuid(), busy = false, m;
    var c1 = colourOf(p);
    var body = h('div'); var qtyOut = h('output', { text: '1' }); var total = h('b'); var actions = h('div', { class: 'checkout-actions' }); var msg = h('div');
    function paint() {
      var t = p.pricePaise * qty; total.textContent = MK.money(t); qtyOut.textContent = String(qty);
      MK.clear(actions);
      if (!c) { actions.appendChild(h('a', { class: 'btn', href: '/login', text: 'Log in to buy' })); return; }
      if (!c.minecraft) { actions.appendChild(h('p', { class: 'checkout-note', text: 'Verify your Minecraft account first so we know who to deliver to.' })); actions.appendChild(h('a', { class: 'btn', href: '/account#profile', text: 'Verify Minecraft account' })); return; }
      if (!s.serverConnected) { actions.appendChild(h('button', { class: 'btn', disabled: true, text: 'Store paused - server offline' })); return; }
      if (c.balancePaise < t) { actions.appendChild(h('p', { class: 'checkout-note', text: 'Wallet balance ' + MK.money(c.balancePaise) + ' - you need ' + MK.money(t - c.balancePaise) + ' more.' })); actions.appendChild(h('a', { class: 'btn', href: '/account#wallet', text: 'Add funds' })); return; }
      var b = h('button', { class: 'btn', type: 'button', text: 'Buy with wallet · ' + MK.money(t) });
      b.addEventListener('click', function () {
        if (busy) return; busy = true; b.disabled = true; MK.clear(msg);
        MK.post('/api/store/purchase', { productId: p.id, quantity: qty, idempotencyKey: key }).then(function (r) {
          c.balancePaise = r.balancePaise; MK.renderHeader('store');
          MK.clear(body).appendChild(h('div', { class: 'stack' }, h('div', { class: 'alert good', text: 'Order ' + r.order.id + ' placed ✓' }),
            h('p', { class: 'muted', text: 'Your items are queued for delivery to ' + c.minecraft.username + '. Delivery happens automatically - track every reward in your account.' }),
            h('div', { class: 'checkout-actions' }, h('a', { class: 'btn', href: '/account#orders', text: 'View my orders' }), h('button', { class: 'btn ghost', type: 'button', text: 'Keep shopping', onclick: function () { m.close(); } }))));
        }).catch(function (e) { busy = false; b.disabled = false; MK.clear(msg).appendChild(h('div', { class: 'alert bad', text: e.message })); });
      });
      actions.appendChild(b);
    }
    var step = function (d) { return h('button', { type: 'button', text: d > 0 ? '+' : '−', onclick: function () { var n = qty + d; if (n < 1 || n > 10) return; qty = n; key = uuid(); paint(); } }); };
    body.appendChild(h('div', { class: 'checkout-item', style: { '--c': c1.accent } },
      p.image ? h('img', { class: 'checkout-thumb', alt: '', src: p.image }) : null,
      h('div', { class: 'checkout-info' }, h('b', { text: p.name }), h('span', { text: p.tagline || p.description }))));
    if (p.description && p.tagline) body.appendChild(h('p', { class: 'muted small', style: { 'margin-bottom': '14px' }, text: p.description }));
    var list = p.isBundle ? p.rewards : p.perks;
    if (list.length) body.appendChild(h('ul', { class: 'bundle-list', style: { '--c': c1.accent } }, list.map(function (t) { return h('li', { text: t }); })));
    body.appendChild(h('div', { class: 'checkout-row' }, h('span', { class: 'label', text: 'Quantity' }), h('div', { class: 'checkout-qty' }, step(-1), qtyOut, step(1))));
    body.appendChild(h('div', { class: 'checkout-total' }, h('span', { class: 'label', text: 'Total' }), total, h('span', { text: 'INR' })));
    if (c && c.minecraft) body.appendChild(h('p', { class: 'checkout-note', style: { 'margin-bottom': '12px' }, text: 'Delivering to Minecraft account: ' + c.minecraft.username }));
    body.appendChild(msg); body.appendChild(actions); paint();
    m = MK.modal('Checkout', body);
  }

  function render() {
    var s = D.store;
    MK.$('storeTitle').textContent = s.name;
    MK.$('storeSubtitle').textContent = s.description || 'Support the server and unlock ranks, bundles and perks.';
    var act = MK.clear(MK.$('heroActions'));
    if (s.discordInvite) act.appendChild(h('a', { class: 'btn', href: s.discordInvite, target: '_blank', rel: 'noopener noreferrer', text: 'Join Discord' }));
    if (s.mcHost) { var ip = s.mcHost + (s.mcPort && s.mcPort !== 25565 ? ':' + s.mcPort : ''); act.appendChild(h('button', { class: 'btn ghost', type: 'button', text: 'Server IP: ' + ip, onclick: function () { MK.copy(ip, 'Server IP copied'); } })); }
    var n = MK.clear(MK.$('notices'));
    if (!s.serverConnected) n.appendChild(h('div', { class: 'alert warn', text: 'Purchases are paused until the store owner connects the Minecraft server.' }));
    if (s.paymentsBlocked) n.appendChild(h('div', { class: 'alert warn', text: 'This store is temporarily unavailable for payments.' }));

    var uncategorised = D.products.some(function (p) { return p.categoryId === null; });
    var tabs = [{ id: 'all', name: 'All' }].concat(D.categories.map(function (c) { return { id: String(c.id), name: c.name }; }));
    if (uncategorised && D.categories.length) tabs.push({ id: 'none', name: 'Other' });
    var tabHost = MK.clear(MK.$('pageTabs'));
    if (tabs.length > 2 || (tabs.length === 2 && uncategorised)) tabs.forEach(function (t) {
      tabHost.appendChild(h('a', { href: '#' + t.id, 'aria-current': t.id === cat ? 'page' : null, text: t.name, onclick: function (e) { e.preventDefault(); cat = t.id; render(); } }));
    });
    var items = D.products.filter(function (p) { return cat === 'all' || (cat === 'none' ? p.categoryId === null : String(p.categoryId) === cat); });
    var current = D.categories.filter(function (c) { return String(c.id) === cat; })[0];
    MK.$('boardTitle').textContent = current ? current.name : 'Everything on the store';
    MK.$('boardText').textContent = current ? current.description : '';
    var grid = MK.clear(MK.$('cardGrid'));
    if (!items.length) grid.appendChild(h('div', { class: 'empty', text: D.products.length ? 'Nothing in this category yet.' : 'The store is being set up - check back soon!' }));
    items.forEach(function (p, i) { grid.appendChild(card(p, i)); });
  }

  MK.init('store').then(function (d) { if (!d) return; D = d; render(); });
})();
