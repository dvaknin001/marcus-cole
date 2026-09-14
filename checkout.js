// On-site paperback shipping chooser / pre-checkout. A "Get the Paperback" button
// (class "buy-paper") opens a checkout-style modal: order line, Standard vs Express with
// prices and delivery estimates, a live total, then "Continue to secure checkout" sends
// the buyer to the matching Gumroad version (payment + address are collected there).
//
// Each button carries:
//   data-title      book name shown in the modal
//   data-cover      optional cover image URL (root-relative, e.g. /lockin-cover.jpg)
//   data-std-url    Gumroad URL for the Standard Shipping version (?variant=...&wanted=true)
//   data-std-price  e.g. "$18.98"
//   data-exp-url    Gumroad URL for the Express Shipping version
//   data-exp-price  e.g. "$27.99"
(function () {
  var STYLE =
    '.bvship-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;padding:20px;z-index:9999;}' +
    '.bvship-overlay.bvship-open{display:flex;}' +
    '.bvship-card{background:var(--bg2,#141414);color:var(--fg,#f4f4f4);border:1px solid rgba(255,255,255,.12);border-top:3px solid var(--red,#e23b2e);border-radius:14px;max-width:410px;width:100%;padding:24px 24px 20px;position:relative;box-shadow:0 24px 60px rgba(0,0,0,.55);}' +
    '.bvship-x{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--muted2,#9a9a9a);font-size:26px;line-height:1;cursor:pointer;padding:6px;z-index:1;}' +
    '.bvship-x:hover{color:#fff;}' +
    '.bvship-head{font-family:"Anton",sans-serif;font-size:15px;letter-spacing:2px;text-transform:uppercase;color:var(--muted2,#9a9a9a);margin:0 0 14px;}' +
    '.bvship-item{display:flex;gap:12px;align-items:center;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid rgba(255,255,255,.1);}' +
    '.bvship-item img{width:44px;height:66px;object-fit:cover;border-radius:3px;flex:none;background:#000;}' +
    '.bvship-item .t{font-weight:700;font-size:15px;line-height:1.25;}' +
    '.bvship-item .s{font-size:12px;color:var(--dim,#7a7a7a);letter-spacing:1px;text-transform:uppercase;}' +
    '.bvship-lbl{font-size:12px;color:var(--muted2,#9a9a9a);letter-spacing:1px;text-transform:uppercase;margin:0 0 8px;}' +
    '.bvship-opt{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 14px;margin-bottom:9px;cursor:pointer;transition:border-color .15s,background .15s;}' +
    '.bvship-opt:has(input:checked){border-color:var(--red,#e23b2e);background:rgba(226,59,46,.08);}' +
    '.bvship-opt input{accent-color:var(--red,#e23b2e);width:17px;height:17px;margin:0 4px 0 0;}' +
    '.bvship-optmain{display:flex;align-items:baseline;gap:8px;flex:1;}' +
    '.bvship-name{font-weight:700;font-size:15px;}' +
    '.bvship-price{font-weight:700;font-size:15px;margin-left:auto;}' +
    '.bvship-eta{flex-basis:100%;font-size:12px;color:var(--dim,#7a7a7a);padding-left:29px;}' +
    '.bvship-total{display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 4px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);}' +
    '.bvship-total .l{font-size:13px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2,#9a9a9a);}' +
    '.bvship-total .v{font-family:"Anton",sans-serif;font-size:26px;color:var(--red,#e23b2e);}' +
    '.bvship-go{display:block;width:100%;text-align:center;margin-top:10px;cursor:pointer;border:none;font-family:inherit;}' +
    '.bvship-foot{font-size:11px;color:var(--dim,#7a7a7a);text-align:center;margin:12px 0 0;letter-spacing:.4px;}';

  var overlay, cur = {};

  function build() {
    var s = document.createElement('style'); s.textContent = STYLE; document.head.appendChild(s);
    overlay = document.createElement('div');
    overlay.className = 'bvship-overlay';
    overlay.innerHTML =
      '<div class="bvship-card" role="dialog" aria-modal="true" aria-label="Checkout">' +
        '<button class="bvship-x" type="button" aria-label="Close">×</button>' +
        '<p class="bvship-head">Your order</p>' +
        '<div class="bvship-item"><img data-cover alt="" hidden><div><div class="t" data-title></div><div class="s">Paperback</div></div></div>' +
        '<p class="bvship-lbl">Shipping</p>' +
        '<label class="bvship-opt"><input type="radio" name="bvship" value="std" checked>' +
          '<span class="bvship-optmain"><span class="bvship-name">Standard shipping</span><span class="bvship-price" data-std></span></span>' +
          '<span class="bvship-eta">Arrives in about 3 weeks</span></label>' +
        '<label class="bvship-opt"><input type="radio" name="bvship" value="exp">' +
          '<span class="bvship-optmain"><span class="bvship-name">Express shipping</span><span class="bvship-price" data-exp></span></span>' +
          '<span class="bvship-eta">Arrives in about 2 weeks</span></label>' +
        '<div class="bvship-total"><span class="l">Total</span><span class="v" data-total></span></div>' +
        '<button class="bvship-go cta btn-red" type="button">Continue to secure checkout &rarr;</button>' +
        '<p class="bvship-foot">Payment and delivery address on the next step. Ships to the UK, USA and Canada.</p>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.bvship-x').addEventListener('click', close);
    overlay.querySelector('.bvship-go').addEventListener('click', go);
    overlay.addEventListener('change', function (e) { if (e.target.name === 'bvship') updateTotal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function updateTotal() {
    var exp = overlay.querySelector('input[value="exp"]').checked;
    overlay.querySelector('[data-total]').textContent = exp ? cur.expPrice : cur.stdPrice;
  }

  function open(btn) {
    if (!overlay) build();
    cur.std = btn.getAttribute('data-std-url');
    cur.exp = btn.getAttribute('data-exp-url');
    cur.stdPrice = btn.getAttribute('data-std-price') || '';
    cur.expPrice = btn.getAttribute('data-exp-price') || '';
    overlay.querySelector('[data-title]').textContent = btn.getAttribute('data-title') || 'Paperback';
    overlay.querySelector('[data-std]').textContent = cur.stdPrice;
    overlay.querySelector('[data-exp]').textContent = cur.expPrice;
    var cover = btn.getAttribute('data-cover');
    var img = overlay.querySelector('[data-cover]');
    if (cover) { img.src = cover; img.hidden = false; } else { img.hidden = true; }
    overlay.querySelector('input[value="std"]').checked = true;
    updateTotal();
    overlay.classList.add('bvship-open');
  }
  function close() { if (overlay) overlay.classList.remove('bvship-open'); }
  function go() {
    var exp = overlay.querySelector('input[value="exp"]').checked;
    var url = exp ? cur.exp : cur.std;
    if (url) window.location.href = url;
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.buy-paper') : null;
    if (b) { e.preventDefault(); open(b); }
  });
})();
