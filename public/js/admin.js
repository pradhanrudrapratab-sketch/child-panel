(function () {
  'use strict';
  var h = MK.h; var root, main, SET = null, cur = 'overview';
  var A = {
    get: function (p) { return MK.get('/api/admin' + p, { admin: true }); },
    post: function (p, b) { return MK.post('/api/admin' + p, b, { admin: true }); },
    put: function (p, b) { return MK.put('/api/admin' + p, b, { admin: true }); },
    del: function (p) { return MK.del('/api/admin' + p, { admin: true }); },
  };
  var PALKEYS = ['red', 'blue', 'yellow', 'purple', 'white', 'pink', 'orange', 'green', 'lime', 'teal', 'cyan', 'indigo', 'magenta', 'gold', 'crimson', 'slate'];
  var err = function (e) { MK.toast(e.message); };

  /* ---------- tiny UI kit ---------- */
  function field(label, input, hint) { return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('small', { text: hint }) : null); }
  function inp(v, o) { return h('input', Object.assign({ type: 'text', value: v === undefined || v === null ? '' : v, autocomplete: 'off' }, o || {})); }
  function area(v, o) { return h('textarea', Object.assign({ value: v || '' }, o || {})); }
  function check(label, on) { var i = h('input', { type: 'checkbox' }); i.checked = !!on; return { el: h('label', { class: 'check' }, i, label), get: function () { return i.checked; } }; }
  function sel(opts, v) { var s = h('select'); opts.forEach(function (o) { var op = h('option', { value: o[0], text: o[1] }); if (String(o[0]) === String(v)) op.selected = true; s.appendChild(op); }); return s; }
  function table(cols, rows, o) {
    o = o || {};
    var t = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, cols.map(function (c) { return h('th', { class: /^#/.test(c) ? 'num' : null, text: c.replace(/^#/, '') }); }))), h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: cols.length, class: 'muted', text: o.empty || 'Nothing here yet.' }))));
    return h('div', { class: 'tbl-wrap' }, t);
  }
  function stat(label, value) { return h('div', { class: 'panel stat' }, h('b', { text: value }), h('span', { text: label })); }
  function title(t, actions) { return h('div', { class: 'page-title' }, h('h1', { text: t }), actions); }
  function confirmPassword(label, fn) {
    var pw = inp('', { type: 'password', autocomplete: 'current-password' }); var m;
    var go = h('button', { class: 'btn danger', type: 'button', text: label, onclick: function () { go.disabled = true; fn(pw.value).then(function () { m.close(); }).catch(function (e) { go.disabled = false; MK.toast(e.message); }); } });
    m = MK.modal('Confirm with your password', h('div', { class: 'stack' }, field('Admin password', pw), go));
  }
  function pre(o) { return h('pre', { class: 'mono small', style: { 'white-space': 'pre-wrap' }, text: JSON.stringify(o, null, 2) }); }

  /* ---------- login ---------- */
  function loginScreen(msg) {
    MK.clear(root);
    var email = inp('', { type: 'email', autocomplete: 'username' }), pw = inp('', { type: 'password', autocomplete: 'current-password' });
    var out = h('div'); var go = h('button', { class: 'btn', type: 'submit', text: 'Log in' });
    var f = h('form', { class: 'panel narrow', style: { margin: 'clamp(20px,5vw,60px) auto' } }, h('h2', { text: 'Store admin' }), h('p', { class: 'sub', text: 'Sign in with the owner email from your Main Panel.' }), msg ? h('div', { class: 'alert warn', text: msg }) : null, out, field('Email', email), field('Password', pw), go);
    f.addEventListener('submit', function (e) {
      e.preventDefault(); go.disabled = true; MK.clear(out);
      MK.post('/api/admin/login', { email: email.value.trim(), password: pw.value }).then(function (r) { MK.adminCsrf = r.csrf; start(r.email); }).catch(function (x) { go.disabled = false; out.appendChild(h('div', { class: 'alert bad', text: x.message })); });
    });
    root.appendChild(f);
  }

  /* ---------- shell ---------- */
  var NAV = [['overview', 'Overview'], ['products', 'Products & bundles'], ['categories', 'Categories'], ['orders', 'Orders'], ['custom', 'Custom orders'], ['transactions', 'Transactions'], ['customers', 'Customers'], '-', ['server', 'Minecraft server'], ['customize', 'Store customization'], ['discord', 'Discord'], ['payments', 'Payments'], ['account', 'Security & audit']];
  function start(email) {
    A.get('/settings').then(function (s) { SET = s; MK.clear(root);
      var hdr = MK.$('app-header'); MK.clear(hdr).appendChild(h('header', { class: 'top' }, h('a', { class: 'brand', href: '/' }, MK.store && MK.store.logo ? (function () { var i = h('img', { class: 'logo', alt: '', src: MK.store.logo }); i.addEventListener('error', function () { i.replaceWith(h('span', { class: 'logo-fallback', text: 'A' })); }); return i; })() : h('span', { class: 'logo-fallback', text: 'A' }), h('span', { text: 'Admin' })),
        h('div', { class: 'top-tools' }, h('span', { class: 'muted small', text: email }), h('a', { class: 'btn ghost sm', href: '/', text: 'View store' }), h('button', { class: 'btn ghost sm', type: 'button', text: 'Log out', onclick: function () { A.post('/logout').then(function () { location.reload(); }); } }))));
      var side = h('nav', { class: 'side panel', 'aria-label': 'Admin' }, NAV.map(function (n) { return n === '-' ? h('div', { class: 'sep' }) : h('button', { type: 'button', 'data-k': n[0], text: n[1], onclick: function () { go(n[0]); } }); }));
      main = h('div', { class: 'stack', style: { 'min-width': '0' } });
      root.appendChild(h('div', { class: 'adm' }, side, main));
      var hsh = location.hash.replace('#', ''); go(NAV.some(function (n) { return n[0] === hsh; }) ? hsh : 'overview');
    }).catch(function (e) { if (e.status === 401) loginScreen('Session expired. Please log in again.'); else err(e); });
  }
  function go(k) {
    cur = k; history.replaceState(null, '', '#' + k);
    document.querySelectorAll('.side button').forEach(function (b) { if (b.getAttribute('data-k') === k) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    MK.clear(main); main.appendChild(h('div', { class: 'muted', text: 'Loading…' }));
    var fn = SECTIONS[k] || SECTIONS.overview;
    Promise.resolve().then(fn).then(function (nodes) { MK.clear(main); MK.add(main, nodes); }).catch(function (e) { if (e.status === 401) { loginScreen('Session expired. Please log in again.'); return; } MK.clear(main).appendChild(h('div', { class: 'alert bad', text: e.message })); });
  }
  var reload = function () { go(cur); };

  /* ---------- overview ---------- */
  function overview() {
    return Promise.all([A.get('/dashboard'), A.get('/settings')]).then(function (r) {
      var d = r[0], s = d.stats; SET = r[1]; var out = [title('Overview')];
      if (['SUSPENDED', 'REVOKED', 'AUTH_ERROR'].indexOf(d.mainPanel.state) >= 0) out.push(h('div', { class: 'alert bad', text: 'Main Panel status: ' + d.mainPanel.state + (d.mainPanel.lastError ? ' - ' + d.mainPanel.lastError : '') }));
      if (!d.plugin || d.plugin.status !== 'ACTIVE') out.push(h('div', { class: 'alert warn', text: 'No Minecraft server is connected. Customers cannot log in with Minecraft or buy items. Open "Minecraft server" to pair one.' }));
      if (s.failedTasks) out.push(h('div', { class: 'alert warn', text: s.failedTasks + ' delivery task(s) failed - open Orders to review and re-queue.' }));
      out.push(h('div', { class: 'grid3' }, stat('Revenue (all time)', MK.money(s.revenuePaise)), stat('Revenue (24h)', MK.money(s.revenue24hPaise)), stat('Deposits credited', MK.money(s.depositsPaise)), stat('Wallet balances held', MK.money(s.walletHeldPaise)),
        stat('Customers', s.customers), stat('Paid orders', s.orders), stat('Products', s.products), stat('Pending deposits', s.pendingDeposits), stat('Open deliveries', s.queued)));
      var online = d.plugin && d.plugin.lastSeenAt && Date.now() - d.plugin.lastSeenAt < 12 * 60 * 1000;
      out.push(h('div', { class: 'grid2' },
        h('div', { class: 'panel stack' }, h('h2', { text: 'Plugin connection' }), d.plugin ? h('div', { class: 'stack' }, h('div', { class: 'row' }, MK.pill(d.plugin.status), h('span', { class: 'pill ' + (online ? 'good' : 'warn'), text: online ? 'ONLINE' : 'NO RECENT CONTACT' })),
          h('p', { class: 'muted small', text: 'Last contact ' + MK.ago(d.plugin.lastSeenAt) + ' · last poll ' + MK.ago(d.plugin.lastPollAt) + (d.plugin.version ? ' · plugin ' + d.plugin.version : '') })) : h('p', { class: 'muted', text: 'Not paired.' })),
        h('div', { class: 'panel stack' }, h('h2', { text: 'Main Panel' }), h('div', { class: 'row' }, MK.pill(d.mainPanel.state)), h('p', { class: 'muted small', text: 'Last OK ' + MK.ago(d.mainPanel.lastOkAt) + ' · last heartbeat ' + MK.ago(d.mainPanel.lastHeartbeatAt) }))));
      out.push(h('h2', { text: 'Recent orders' }), ordersTable(d.recentOrders));
      return out;
    });
  }

  /* ---------- products ---------- */
  function products() {
    return Promise.all([A.get('/products'), A.get('/categories')]).then(function (r) {
      var cats = r[1].categories, byId = {}; cats.forEach(function (c) { byId[c.id] = c.name; });
      var rows = r[0].products.map(function (p) {
        var tr = h('tr', { class: 'click' }, h('td', null, h('b', { text: p.name })), h('td', { text: p.categoryId ? byId[p.categoryId] || '-' : '-' }), h('td', null, p.isBundle ? MK.pill('BUNDLE') : h('span', { class: 'muted small', text: 'single' })), h('td', { class: 'num', text: MK.money(p.pricePaise) }), h('td', { class: 'num', text: p.rewards.length }), h('td', null, p.active ? MK.pill('ACTIVE') : MK.pill('HIDDEN')));
        tr.addEventListener('click', function () { productForm(p, cats); }); return tr;
      });
      return [title('Products & bundles', h('button', { class: 'btn', type: 'button', text: '+ New product', onclick: function () { productForm(null, cats); } })), table(['Name', 'Category', 'Type', '#Price', '#Rewards', 'Status'], rows, { empty: 'No products yet. Create your first one.' })];
    });
  }
  function productForm(p, cats) {
    var isNew = !p; p = p || { name: '', tagline: '', description: '', pricePaise: 0, image: '', perks: [], badge: '', colour: '', featured: false, active: true, isBundle: false, sort: 0, categoryId: '', rewards: [{ label: '', command: '' }] };
    var f = {
      name: inp(p.name, { maxlength: 80 }), tagline: inp(p.tagline, { maxlength: 140 }), description: area(p.description, { maxlength: 1000 }), price: inp(isNew ? '' : (p.pricePaise / 100).toFixed(2), { inputmode: 'decimal', placeholder: '49.00' }),
      image: inp(p.image, { placeholder: 'https://…' }), cat: sel([['', '— none —']].concat(cats.map(function (c) { return [c.id, c.name]; })), p.categoryId || ''), badge: inp(p.badge, { maxlength: 24 }), sort: inp(p.sort, { inputmode: 'numeric' }),
      colour: sel([['', 'Store default']].concat(PALKEYS.map(function (k) { return [k, k]; })), p.colour), perks: area((p.perks || []).join('\n'), { placeholder: 'One perk per line' }),
    };
    var cf = check('Featured ("most popular")', p.featured), ca = check('Visible in store', p.active), cb = check('Bundle (several rewards tracked separately)', p.isBundle);
    var rewardsHost = h('div'); var rows = [];
    function addRow(r) {
      var l = inp(r.label, { placeholder: 'Reward label (e.g. 64 Diamonds)', maxlength: 80 }), c = inp(r.command, { placeholder: 'give %player% diamond 64', maxlength: 256 });
      var row = { l: l, c: c }; rows.push(row);
      var el = h('div', { class: 'reward-row' }, l, c, h('button', { type: 'button', title: 'Remove', text: '✕', onclick: function () { if (rows.length < 2) return; rows.splice(rows.indexOf(row), 1); el.remove(); } }));
      rewardsHost.appendChild(el);
    }
    (p.rewards.length ? p.rewards : [{ label: '', command: '' }]).forEach(addRow);
    var msg = h('div'); var m;
    var save = h('button', { class: 'btn', type: 'button', text: isNew ? 'Create product' : 'Save changes', onclick: function () {
      var body = { name: f.name.value, tagline: f.tagline.value, description: f.description.value, price: f.price.value.trim(), image: f.image.value.trim(), categoryId: f.cat.value === '' ? null : Number(f.cat.value), badge: f.badge.value, colour: f.colour.value, sort: f.sort.value || 0,
        featured: cf.get(), active: ca.get(), isBundle: cb.get(), perks: f.perks.value.split('\n'), rewards: rows.map(function (r) { return { label: r.l.value, command: r.c.value }; }) };
      save.disabled = true; MK.clear(msg);
      (isNew ? A.post('/products', body) : A.put('/products/' + p.id, body)).then(function () { m.close(); MK.toast('Saved ✓'); reload(); }).catch(function (e) { save.disabled = false; msg.appendChild(h('div', { class: 'alert bad', text: e.message })); });
    } });
    var del = isNew ? null : h('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: function () { if (confirm('Delete "' + p.name + '"? Past orders keep their history.')) A.del('/products/' + p.id).then(function () { m.close(); reload(); }).catch(err); } });
    var body = h('div', { class: 'stack' }, msg, h('div', { class: 'grid2' }, field('Product name', f.name), field('Price (₹)', f.price, 'Always read from the database at purchase time.')), field('Tagline', f.tagline), field('Description', f.description),
      h('div', { class: 'grid2' }, field('Image URL', f.image, 'https only'), field('Category', f.cat)), h('div', { class: 'grid3' }, field('Badge', f.badge), field('Card colour', f.colour), field('Sort order', f.sort)),
      field('Perks shown on the card', f.perks), h('div', { class: 'row' }, cf.el, ca.el, cb.el),
      h('div', null, h('label', { class: 'muted small', text: 'DELIVERY COMMANDS / REWARDS' }), h('p', { class: 'muted small', text: 'Use %player% for the buyer\'s verified Minecraft name. Every row is delivered and tracked as its own task.' }), rewardsHost,
        h('button', { class: 'btn ghost sm', type: 'button', text: '+ Add reward', onclick: function () { addRow({ label: '', command: '' }); } })), h('div', { class: 'row end' }, del, save));
    m = MK.modal(isNew ? 'New product' : 'Edit product', body, { wide: true });
  }

  /* ---------- categories ---------- */
  function categories() {
    return A.get('/categories').then(function (r) {
      var rows = r.categories.map(function (c) { var tr = h('tr', { class: 'click' }, h('td', null, h('b', { text: c.name })), h('td', { class: 'muted', text: c.description }), h('td', { class: 'num', text: c.products }), h('td', null, c.active ? MK.pill('ACTIVE') : MK.pill('HIDDEN'))); tr.addEventListener('click', function () { catForm(c); }); return tr; });
      return [title('Categories', h('button', { class: 'btn', type: 'button', text: '+ New category', onclick: function () { catForm(null); } })), table(['Name', 'Description', '#Products', 'Status'], rows, { empty: 'No categories yet.' })];
    });
  }
  function catForm(c) {
    var isNew = !c; c = c || { name: '', description: '', image: '', sort: 0, active: true };
    var n = inp(c.name, { maxlength: 60 }), d = area(c.description, { maxlength: 300 }), i = inp(c.image, { placeholder: 'https://…' }), s = inp(c.sort), act = check('Visible in store', c.active); var m, msg = h('div');
    var save = h('button', { class: 'btn', type: 'button', text: 'Save', onclick: function () { var b = { name: n.value, description: d.value, image: i.value.trim(), sort: s.value || 0, active: act.get() }; save.disabled = true; (isNew ? A.post('/categories', b) : A.put('/categories/' + c.id, b)).then(function () { m.close(); reload(); }).catch(function (e) { save.disabled = false; MK.clear(msg).appendChild(h('div', { class: 'alert bad', text: e.message })); }); } });
    var del = isNew ? null : h('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: function () { if (confirm('Delete this category? Its products stay in the store, uncategorised.')) A.del('/categories/' + c.id).then(function () { m.close(); reload(); }).catch(err); } });
    m = MK.modal(isNew ? 'New category' : 'Edit category', h('div', { class: 'stack' }, msg, field('Name', n), field('Description', d), field('Icon / image URL', i), field('Sort order', s), act.el, h('div', { class: 'row end' }, del, save)));
  }

  /* ---------- orders ---------- */
  function ordersTable(list) {
    var rows = list.map(function (o) {
      var tr = h('tr', { class: 'click' }, h('td', { class: 'mono', text: o.id }), h('td', null, o.discord || h('span', { class: 'muted', text: '—' })), h('td', { text: o.minecraft }), h('td', null, h('b', { text: o.product }), o.kind !== 'PURCHASE' ? h('span', { class: 'muted small', text: ' · ' + o.kind.toLowerCase() }) : null, o.isBundle ? h('span', { class: 'muted small', text: ' · bundle' }) : null),
        h('td', { class: 'num', text: o.amountPaise ? MK.money(o.amountPaise) : '—' }), h('td', null, MK.pill(o.paymentStatus === 'PAID' ? 'PAID' : 'NOT_APPLICABLE')), h('td', null, MK.pill(o.deliveryStatus), h('span', { class: 'muted small', text: ' ' + o.progress.delivered + '/' + o.progress.total })), h('td', { text: MK.date(o.createdAt) }));
      tr.addEventListener('click', function () { orderDetail(o.id); }); return tr;
    });
    return table(['Order', 'Discord', 'Minecraft', 'Product', '#Amount', 'Payment', 'Delivery', 'Created'], rows, { empty: 'No orders found.' });
  }
  var oq = { q: '', status: '', kind: '', sort: 'created', dir: 'desc', offset: 0 };
  function orders() {
    var qs = new URLSearchParams(Object.assign({}, oq, { limit: 25 })).toString();
    return A.get('/orders?' + qs).then(function (r) {
      var q = inp(oq.q, { placeholder: 'Search order, player, Discord, product' }); var st = sel([['', 'Any delivery status'], ['PENDING', 'Pending'], ['PROCESSING', 'Processing'], ['RECEIVED', 'Received'], ['SCHEDULED', 'Scheduled'], ['DELIVERED', 'Delivered'], ['FAILED', 'Failed'], ['CANCELLED', 'Cancelled']], oq.status);
      var kd = sel([['', 'All types'], ['PURCHASE', 'Purchases'], ['GIVEAWAY', 'Giveaways'], ['MANUAL', 'Manual'], ['CUSTOM', 'Custom']], oq.kind); var so = sel([['created', 'Newest'], ['amount', 'Amount'], ['product', 'Product'], ['status', 'Status']], oq.sort);
      var apply = function () { oq.q = q.value; oq.status = st.value; oq.kind = kd.value; oq.sort = so.value; oq.offset = 0; reload(); };
      q.addEventListener('keydown', function (e) { if (e.key === 'Enter') apply(); });
      var pager = h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', text: '← Prev', disabled: oq.offset === 0, onclick: function () { oq.offset = Math.max(0, oq.offset - 25); reload(); } }), h('span', { class: 'muted small', text: (r.total ? oq.offset + 1 : 0) + '–' + Math.min(oq.offset + 25, r.total) + ' of ' + r.total }), h('button', { class: 'btn ghost sm', type: 'button', text: 'Next →', disabled: oq.offset + 25 >= r.total, onclick: function () { oq.offset += 25; reload(); } }));
      return [title('Order history'), h('div', { class: 'panel row' }, h('div', { class: 'grow' }, q), st, kd, so, h('button', { class: 'btn sm', type: 'button', text: 'Apply', onclick: apply })), ordersTable(r.orders), pager];
    });
  }
  function orderDetail(id) {
    var body = h('div', { class: 'stack' }), m = MK.modal('Order ' + id, body, { wide: true });
    A.get('/orders/' + id).then(function (r) {
      var o = r.order; MK.clear(body);
      body.appendChild(h('div', { class: 'row' }, h('b', { text: o.product }), MK.pill(o.deliveryStatus), MK.pill(o.paymentStatus === 'PAID' ? 'PAID' : 'NOT_APPLICABLE'), h('span', { class: 'muted small', text: o.kind.toLowerCase() + ' · ' + MK.date(o.createdAt) })));
      body.appendChild(h('p', { class: 'muted small', text: 'Minecraft: ' + o.minecraft + (o.discord ? ' · Discord: ' + o.discord : '') + ' · Amount: ' + (o.amountPaise ? MK.money(o.amountPaise) : 'none') + (o.quantity > 1 ? ' · qty ' + o.quantity : '') + (o.createdBy ? ' · by ' + o.createdBy : '') + (o.note ? ' · note: ' + o.note : '') }));
      body.appendChild(h('p', { class: 'muted small', text: 'Progress: ' + o.progress.delivered + ' of ' + o.progress.total + ' rewards delivered' }));
      body.appendChild(table(['Reward', 'Command', 'Status', 'Polls', ''], o.tasks.map(function (t) {
        var acts = h('div', { class: 'row' });
        if (['FETCHED', 'QUEUED'].indexOf(t.rawStatus) >= 0) acts.appendChild(h('button', { class: 'btn ghost sm', type: 'button', text: 'Cancel', onclick: function () { A.post('/tasks/' + t.id + '/cancel').then(function () { m.close(); orderDetail(id); reload(); }).catch(err); } }));
        if (['FAILED', 'FETCHED', 'RECEIVED'].indexOf(t.rawStatus) >= 0) acts.appendChild(h('button', { class: 'btn ghost sm', type: 'button', text: 'Re-queue', onclick: function () { if (confirm('Re-queue this reward? If the plugin already ran it, the player may receive it twice.')) A.post('/tasks/' + t.id + '/requeue').then(function () { m.close(); orderDetail(id); reload(); }).catch(err); } }));
        return h('tr', null, h('td', { text: t.label }), h('td', { class: 'mono small', text: t.command }), h('td', null, MK.pill(t.status), t.failReason ? h('div', { class: 'small neg', text: t.failReason }) : null), h('td', { class: 'num', text: t.fetchCount }), h('td', null, acts));
      })));
      if (o.tasks.some(function (t) { return ['QUEUED', 'FETCHED'].indexOf(t.rawStatus) >= 0; })) body.appendChild(h('div', { class: 'row end' }, h('button', { class: 'btn danger sm', type: 'button', text: 'Cancel undelivered rewards', onclick: function () { if (confirm('Cancel every reward the plugin has not confirmed yet?')) A.post('/orders/' + id + '/cancel').then(function () { m.close(); reload(); }).catch(err); } })));
    }).catch(function (e) { MK.clear(body).appendChild(h('div', { class: 'alert bad', text: e.message })); });
  }

  /* ---------- custom orders ---------- */
  function custom() {
    var kind = sel([['GIVEAWAY', 'Giveaway'], ['MANUAL', 'Manual order'], ['CUSTOM', 'Custom reward']], 'GIVEAWAY'), mc = inp('', { maxlength: 16, placeholder: 'Minecraft username' }), name = inp('', { maxlength: 80, placeholder: 'e.g. Event winner prize' }), note = inp('', { maxlength: 300 }), when = inp('', { type: 'datetime-local' });
    var host = h('div'), rows = [];
    function add() { var l = inp('', { placeholder: 'Label', maxlength: 80 }), c = inp('', { placeholder: 'give %player% diamond 5', maxlength: 256 }); var row = { l: l, c: c }; rows.push(row); var el = h('div', { class: 'reward-row' }, l, c, h('button', { type: 'button', text: '✕', onclick: function () { if (rows.length < 2) return; rows.splice(rows.indexOf(row), 1); el.remove(); } })); host.appendChild(el); }
    add(); var msg = h('div');
    var go2 = h('button', { class: 'btn', type: 'button', text: 'Queue delivery', onclick: function () {
      go2.disabled = true; MK.clear(msg);
      A.post('/orders/custom', { kind: kind.value, minecraft: mc.value.trim(), name: name.value, note: note.value, deliverAt: when.value ? new Date(when.value).getTime() : null, rewards: rows.map(function (r) { return { label: r.l.value, command: r.c.value }; }) })
        .then(function (r) { MK.toast('Queued: order ' + r.order.id); go('orders'); }).catch(function (e) { go2.disabled = false; msg.appendChild(h('div', { class: 'alert bad', text: e.message })); });
    } });
    return [title('Custom orders & giveaways'), h('div', { class: 'panel stack' }, h('p', { class: 'sub', text: 'Not shown in the catalogue and never charges a wallet. Delivered through the same plugin queue with the same confirmation steps.' }), msg,
      h('div', { class: 'grid2' }, field('Type', kind), field('Minecraft username', mc)), field('Title', name), field('Internal note', note), field('Deliver at (optional, leave empty for now)', when),
      h('div', null, h('label', { class: 'muted small', text: 'COMMANDS' }), host, h('button', { class: 'btn ghost sm', type: 'button', text: '+ Add command', onclick: add })), go2)];
  }

  /* ---------- transactions ---------- */
  function transactions() {
    return A.get('/transactions?limit=200').then(function (r) {
      var rows = r.transactions.map(function (t) {
        var dep = t.kind === 'deposit';
        return h('tr', null, h('td', { text: MK.date(t.at) }), h('td', { text: t.customer || '-' }), h('td', null, MK.pill(dep ? 'DEPOSIT' : t.type)), h('td', { class: 'num ' + (dep || t.amountPaise > 0 ? 'pos' : 'neg'), text: (dep ? '+' : t.amountPaise > 0 ? '+' : '') + MK.money(dep ? t.amountPaise : t.amountPaise) }),
          h('td', null, dep ? MK.pill(t.expired && t.status === 'PENDING' ? 'EXPIRED' : t.status) : h('span', { class: 'muted small', text: 'bal ' + MK.money(t.balanceAfterPaise) })), h('td', { class: 'muted small mono', text: dep ? t.id : (t.note || '') }));
      });
      return [title('Transaction history'), h('p', { class: 'muted small', text: 'Deposits and wallet movements. Orders are listed separately under Orders.' }), table(['Date', 'Customer', 'Type', '#Amount', 'Status', 'Reference'], rows, { empty: 'No transactions yet.' })];
    });
  }

  /* ---------- customers ---------- */
  var cq = '';
  function customers() {
    return A.get('/customers?q=' + encodeURIComponent(cq)).then(function (r) {
      var q = inp(cq, { placeholder: 'Search Discord, Minecraft or ID' }); var s = function () { cq = q.value.trim(); reload(); }; q.addEventListener('keydown', function (e) { if (e.key === 'Enter') s(); });
      var rows = r.customers.map(function (c) { var tr = h('tr', { class: 'click' }, h('td', { text: '#' + c.id }), h('td', { text: c.discord ? c.discord.username : '—' }), h('td', { text: c.minecraft ? c.minecraft.username : '—' }), h('td', { class: 'num', text: MK.money(c.balancePaise) }), h('td', { text: MK.date(c.createdAt) })); tr.addEventListener('click', function () { customerDetail(c.id); }); return tr; });
      return [title('Customers'), h('div', { class: 'panel row' }, h('div', { class: 'grow' }, q), h('button', { class: 'btn sm', type: 'button', text: 'Search', onclick: s })), table(['ID', 'Discord', 'Minecraft', '#Wallet', 'Joined'], rows, { empty: 'No customers yet.' })];
    });
  }
  function customerDetail(id) {
    var body = h('div', { class: 'stack' }), m = MK.modal('Customer #' + id, body, { wide: true });
    A.get('/customers/' + id).then(function (r) {
      var c = r.customer; MK.clear(body);
      body.appendChild(h('div', { class: 'row' }, c.minecraft ? h('img', { class: 'head-mc', alt: '', src: MK.mcHead(c.minecraft.username) }) : null, h('div', { class: 'grow' }, h('b', { text: (c.discord ? c.discord.username : '') + (c.discord && c.minecraft ? ' · ' : '') + (c.minecraft ? c.minecraft.username : '') }), h('div', { class: 'muted small', text: c.discord ? 'Discord ID ' + c.discord.id : 'Minecraft-only account' })), h('div', { class: 'balance', text: MK.money(c.balancePaise) })));
      var amt = inp('', { placeholder: '+100 or -50 (₹)', inputmode: 'decimal' }), note = inp('', { placeholder: 'Reason', maxlength: 200 });
      body.appendChild(h('div', { class: 'panel stack' }, h('h3', { text: 'Wallet adjustment' }), h('div', { class: 'grid2' }, field('Amount', amt), field('Note', note)), h('button', { class: 'btn sm', type: 'button', text: 'Apply adjustment', onclick: function () { A.post('/customers/' + id + '/adjust', { amount: amt.value, note: note.value }).then(function (x) { MK.toast('New balance ' + MK.money(x.balancePaise)); m.close(); customerDetail(id); reload(); }).catch(err); } })));
      body.appendChild(h('h3', { text: 'Orders' })); body.appendChild(ordersTable(r.orders));
      body.appendChild(h('h3', { text: 'Wallet activity' }));
      body.appendChild(table(['Date', 'Details', '#Amount', 'Status'], r.transactions.map(function (t) { var dep = t.kind === 'deposit'; return h('tr', null, h('td', { text: MK.date(t.at) }), h('td', { text: dep ? 'Deposit ' + t.id : t.type + (t.note ? ' - ' + t.note : '') }), h('td', { class: 'num', text: MK.money(t.amountPaise) }), h('td', null, MK.pill(dep ? t.status : 'DONE'))); }), { empty: 'No activity.' }));
    }).catch(function (e) { MK.clear(body).appendChild(h('div', { class: 'alert bad', text: e.message })); });
  }

  /* ---------- Minecraft server + Main Panel ---------- */
  function server() {
    return A.get('/settings').then(function (s) {
      SET = s; var sv = s.server, mp = s.main, out = [title('Minecraft server & plugin')];
      var online = sv && sv.lastSeenAt && Date.now() - sv.lastSeenAt < 12 * 60 * 1000;
      var card = h('div', { class: 'panel stack' }, h('h2', { text: 'Connected server' }));
      if (sv && sv.status === 'ACTIVE') {
        card.appendChild(h('div', { class: 'row' }, MK.pill('ACTIVE'), h('span', { class: 'pill ' + (online ? 'good' : 'warn'), text: online ? 'PLUGIN ONLINE' : 'NO RECENT CONTACT' })));
        card.appendChild(h('p', { class: 'muted small', text: sv.name + ' · ID ' + sv.id + ' · paired ' + MK.date(sv.pairedAt) + ' · last contact ' + MK.ago(sv.lastSeenAt) + ' · last poll ' + MK.ago(sv.lastPollAt) + (sv.version ? ' · plugin ' + sv.version : '') }));
        card.appendChild(h('p', { class: 'muted small', text: 'Exactly one server can be connected. To use a different one, disconnect this one first.' }));
        card.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn danger sm', type: 'button', text: 'Disconnect / revoke server', onclick: function () { confirmPassword('Revoke server', function (pw) { return A.post('/server/revoke', { password: pw }).then(function () { MK.toast('Server revoked'); reload(); }); }); } })));
      } else {
        card.appendChild(h('div', { class: 'alert warn', text: sv && sv.status === 'REVOKED' ? 'The previous server was revoked and can no longer connect. Pair a new one.' : 'No server connected yet.' }));
        var box = h('div');
        card.appendChild(h('button', { class: 'btn', type: 'button', text: 'Generate pairing code', onclick: function () {
          A.post('/server/pairing-code').then(function (r) {
            MK.clear(box).appendChild(h('div', { class: 'stack' }, h('div', { class: 'cmd' }, h('code', { text: r.code }), h('button', { class: 'btn ghost sm', type: 'button', text: 'Copy', onclick: function () { MK.copy(r.code, 'Code copied'); } })),
              h('p', { class: 'muted small', text: 'Valid for 15 minutes, single use. Send it from the plugin to POST ' + location.origin + '/api/plugin/pair as {"code": "…"}. The plugin receives its own API key.' })));
          }).catch(err);
        } })); card.appendChild(box);
      }
      out.push(card);
      var mpc = h('div', { class: 'panel stack' }, h('h2', { text: 'Main Panel connection' }));
      if (!mp.contractConfirmed) mpc.appendChild(h('div', { class: 'alert warn', text: 'API contract unconfirmed - see data/contract.json / README.' }));
      mpc.appendChild(h('div', { class: 'row' }, MK.pill(mp.state), h('span', { class: 'muted small', text: mp.url + ' · panel ' + mp.panelId })));
      mpc.appendChild(h('p', { class: 'muted small', text: 'Last OK ' + MK.ago(mp.lastOkAt) + ' · last heartbeat ' + MK.ago(mp.lastHeartbeatAt) + (mp.lastError ? ' · last error: ' + mp.lastError : '') + (mp.serverInfoError ? ' · server-info error: ' + mp.serverInfoError : '') }));
      mpc.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', text: 'Send heartbeat & sync server info', onclick: function () { A.post('/main/refresh').then(function () { MK.toast('Synced'); reload(); }).catch(err); } }),
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Rotate panel secret', onclick: function () { confirmPassword('Rotate secret', function (pw) { return A.post('/main/rotate-secret', { password: pw }).then(function () { MK.toast('Secret rotated ✓'); reload(); }); }); } })));
      out.push(mpc);
      return out;
    });
  }

  /* ---------- store customization ---------- */
  function customize() {
    return A.get('/settings').then(function (s) {
      var c = s.store, f = { name: inp(c.name, { maxlength: 60 }), icon: inp(c.icon, { placeholder: 'https://…' }), logo: inp(c.logo, { placeholder: 'https://…' }), favicon: inp(c.favicon, { placeholder: 'https://…' }), invite: inp(c.discordInvite, { placeholder: 'https://discord.gg/…' }),
        host: inp(c.mcHost, { placeholder: 'play.example.com' }), port: inp(c.mcPort, { placeholder: '25565', inputmode: 'numeric' }), desc: area(c.description, { maxlength: 300 }), site: inp(c.website, { placeholder: 'https://…' }), colour: sel(PALKEYS.map(function (k) { return [k, k]; }), c.defaultColour) };
      var prev = h('div', { class: 'preview' }); var swatch = h('span', { class: 'swatch', style: { background: s.palette[c.defaultColour] || '#3b82ff', cursor: 'default' } });
      function paintPrev() {
        MK.clear(prev); var img = function (u) { if (!MK.safeHref(u)) return null; var i = h('img', { alt: '', src: u }); i.addEventListener('error', function () { i.style.opacity = '.25'; }); return i; };
        prev.appendChild(h('div', { class: 'row' }, img(f.logo.value) || img(f.icon.value) || h('span', { class: 'logo-fallback', text: (f.name.value || 'S').charAt(0).toUpperCase() }), h('b', { text: f.name.value || 'Store name' })));
        prev.appendChild(h('div', { class: 'row' }, h('span', { class: 'muted small', text: 'Favicon:' }), img(f.favicon.value) || h('span', { class: 'muted small', text: 'default' }), swatch));
        swatch.style.background = s.palette[f.colour.value] || '#3b82ff';
      }
      ['name', 'icon', 'logo', 'favicon', 'colour'].forEach(function (k) { f[k].addEventListener('input', paintPrev); f[k].addEventListener('change', paintPrev); }); paintPrev();
      var msg = h('div'); var save = h('button', { class: 'btn', type: 'button', text: 'Save store settings', onclick: function () {
        save.disabled = true; MK.clear(msg);
        A.put('/settings/store', { name: f.name.value, icon: f.icon.value.trim(), logo: f.logo.value.trim(), favicon: f.favicon.value.trim(), discordInvite: f.invite.value.trim(), mcHost: f.host.value.trim(), mcPort: f.port.value.trim(), description: f.desc.value, website: f.site.value.trim(), defaultColour: f.colour.value })
          .then(function () { MK.toast('Saved ✓ - synced to the Main Panel'); MK.setFavicon(f.favicon.value.trim() || f.icon.value.trim()); save.disabled = false; }).catch(function (e) { save.disabled = false; msg.appendChild(h('div', { class: 'alert bad', text: e.message })); });
      } });
      return [title('Store customization'), h('div', { class: 'panel stack' }, msg, h('h3', { text: 'Live preview' }), prev, h('div', { class: 'grid2' }, field('Store name', f.name), field('Default colour', f.colour, 'Customers can still pick their own accent.')),
        h('div', { class: 'grid2' }, field('Store icon URL', f.icon), field('Store logo URL', f.logo)), field('Favicon URL', f.favicon, 'Shown in the browser tab. https links only.'),
        h('div', { class: 'grid3' }, field('Discord invite', f.invite), field('Minecraft server IP', f.host), field('Port', f.port)), field('Server description', f.desc), field('Website URL', f.site), save)];
    });
  }

  /* ---------- Discord ---------- */
  function discord() {
    return A.get('/settings').then(function (s) {
      var d = s.discord, f = { id: inp(d.clientId, { inputmode: 'numeric' }), secret: inp('', { type: 'password', placeholder: d.hasClientSecret ? '•••••••• saved - leave empty to keep' : 'Client secret', autocomplete: 'new-password' }), bot: inp('', { type: 'password', placeholder: d.hasBotToken ? '•••••••• saved - leave empty to keep' : 'Bot token (optional)', autocomplete: 'new-password' }), ch: inp(d.logChannel, { inputmode: 'numeric', placeholder: 'Deposit log channel ID (optional)' }) };
      var msg = h('div'); var save = h('button', { class: 'btn', type: 'button', text: 'Save Discord settings', onclick: function () {
        save.disabled = true; MK.clear(msg); A.put('/settings/discord', { clientId: f.id.value.trim(), clientSecret: f.secret.value, botToken: f.bot.value, logChannel: f.ch.value.trim() }).then(function () { MK.toast('Saved ✓'); reload(); }).catch(function (e) { save.disabled = false; msg.appendChild(h('div', { class: 'alert bad', text: e.message })); });
      } });
      var uri = d.redirectUri;
      return [title('Discord'), h('div', { class: 'panel stack' }, msg, h('p', { class: 'sub', text: 'Customers log in with Discord OAuth2. Create an application at discord.com/developers and add this redirect URL:' }), h('div', { class: 'cmd' }, h('code', { text: uri }), h('button', { class: 'btn ghost sm', type: 'button', text: 'Copy', onclick: function () { MK.copy(uri, 'Redirect URL copied'); } })),
        field('Client ID', f.id), field('Client secret', f.secret, 'Stored encrypted on the server. Never sent back to the browser.'), field('Bot token', f.bot, 'Only needed to post deposit notifications.'), field('Deposit log channel ID', f.ch),
        h('div', { class: 'row' }, save, d.hasClientSecret ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove client secret', onclick: function () { A.put('/settings/discord', { clientId: f.id.value.trim(), logChannel: f.ch.value.trim(), clearClientSecret: true }).then(reload).catch(err); } }) : null, d.hasBotToken ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove bot token', onclick: function () { A.put('/settings/discord', { clientId: f.id.value.trim(), logChannel: f.ch.value.trim(), clearBotToken: true }).then(reload).catch(err); } }) : null))];
    });
  }

  /* ---------- payments ---------- */
  function payments() {
    return Promise.all([A.get('/payment'), A.get('/settings')]).then(function (r) {
      var ps = r[0], g = r[1].general, out = [title('Payments')];
      out.push(h('div', { class: 'panel stack' }, h('h2', { text: 'Main Panel payment status' }), ps.ok ? pre(ps.status) : h('div', { class: 'alert bad', text: ps.error })));
      var upi = inp('', { placeholder: 'name@bank' }), gm = inp('', { type: 'email', placeholder: 'yourname@gmail.com', autocomplete: 'off' }), app = inp('', { type: 'password', placeholder: '16-character Google app password', autocomplete: 'new-password' }); var m1 = h('div');
      out.push(h('div', { class: 'panel stack' }, h('h2', { text: 'Payment configuration' }), h('p', { class: 'sub', text: 'Sent to the Main Panel, which watches the Gmail inbox for FamPay payment emails and confirms deposits. The app password is write-only: it is never shown again.' }), m1, field('UPI ID', upi), field('Gmail address', gm, 'The inbox that receives FamPay payment emails.'), field('Gmail app password', app, 'Google Account > Security > 2-Step Verification > App passwords.'),
        h('button', { class: 'btn', type: 'button', text: 'Save payment configuration', onclick: function () { A.put('/payment', { upiId: upi.value.trim(), gmail: gm.value.trim(), appPassword: app.value }).then(function () { MK.toast('Saved ✓'); reload(); }).catch(function (e) { MK.clear(m1).appendChild(h('div', { class: 'alert bad', text: e.message })); }); } })));
      var mn = inp(g.minDeposit, { inputmode: 'decimal' }), mx = inp(g.maxDeposit, { inputmode: 'decimal' }), pub = inp(g.publicUrl), hops = inp(g.trustProxyHops, { inputmode: 'numeric' });
      out.push(h('div', { class: 'panel stack' }, h('h2', { text: 'Limits & network' }), h('div', { class: 'grid2' }, field('Minimum deposit (₹)', mn), field('Maximum deposit (₹)', mx)), field('Public URL of this panel', pub, 'Used for Discord login redirects. Must match your Discord application.'), field('Reverse-proxy hops to trust for client IP', hops, '1 for Render/most hosts, 0 if exposed directly.'),
        h('button', { class: 'btn', type: 'button', text: 'Save', onclick: function () { A.put('/settings/general', { minDeposit: mn.value, maxDeposit: mx.value, publicUrl: pub.value.trim(), trustProxyHops: hops.value }).then(function () { MK.toast('Saved ✓'); }).catch(err); } })));
      return out;
    });
  }

  /* ---------- security & audit ---------- */
  function account() {
    return A.get('/audit').then(function (r) {
      var cur2 = inp('', { type: 'password', autocomplete: 'current-password' }), n1 = inp('', { type: 'password', autocomplete: 'new-password' }), n2 = inp('', { type: 'password', autocomplete: 'new-password' });
      var rows = r.entries.map(function (e) { return h('tr', null, h('td', { text: MK.date(e.created_at) }), h('td', { text: e.actor }), h('td', { class: 'mono', text: e.action }), h('td', { class: 'mono small', text: e.detail || '' }), h('td', { class: 'muted small', text: e.ip || '' })); });
      return [title('Security & audit'), h('div', { class: 'panel stack' }, h('h2', { text: 'Change admin password' }), field('Current password', cur2), field('New password (10+ characters)', n1), field('Repeat new password', n2),
        h('button', { class: 'btn', type: 'button', text: 'Change password', onclick: function () { if (n1.value !== n2.value) { MK.toast('Passwords do not match'); return; } A.put('/account/password', { current: cur2.value, next: n1.value }).then(function () { MK.toast('Password changed - other sessions logged out'); cur2.value = n1.value = n2.value = ''; }).catch(err); } })),
        h('h2', { text: 'Audit log' }), table(['Time', 'Actor', 'Action', 'Detail', 'IP'], rows, { empty: 'No entries.' })];
    });
  }

  var SECTIONS = { overview: overview, products: products, categories: categories, orders: orders, custom: custom, transactions: transactions, customers: customers, server: server, customize: customize, discord: discord, payments: payments, account: account };

  MK.init('none', { title: 'Admin' }).then(function (d) {
    if (!d) return; root = MK.$('adminRoot');
    MK.get('/api/admin/me', { admin: true }).then(function (r) { MK.adminCsrf = r.csrf; start(r.email); }).catch(function () { loginScreen(); });
  });
})();
