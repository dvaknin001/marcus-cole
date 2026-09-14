// On-site paperback shipping chooser. A "Get the Paperback" button (class "buy-paper")
// opens a small modal that shows Standard vs Express with prices and delivery estimates;
// "Continue to checkout" sends the buyer to the matching Gumroad version. This keeps the
// shipping choice on-brand and makes the buyer decide the tier before Gumroad opens.
//
// Each button carries the data it needs:
//   data-title      book name shown in the modal
//   data-std-url    Gumroad URL for the Standard Shipping version (?variant=...&wanted=true)
//   data-std-price  e.g. "$18.98"
//   data-exp-url    Gumroad URL for the Express Shipping version
//   data-exp-price  e.g. "$27.99"
(function () {
  var STYLE =
    '.bvship-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:20px;z-index:9999;}' +
    '.bvship-card{background:var(--bg2,#141414);color:var(--fg,#f4f4f4);border:1px solid rgba(255,255,255,.12);border-top:3px solid var(--red,#e23b2e);border-radius:14px;max-width:400px;width:100%;padding:26px 24px 22px;position:relative;box-shadow:0 24px 60px rgba(0,0,0,.5);}' +
    '.bvship-x{position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted2,#9a9a9a);font-size:26px;line-height:1;cursor:pointer;padding:4px;}' +
    '.bvship-title{font-family:"Anton",sans-serif;font-size:24px;margin:0 0 2px;letter-spacing:.5px;}' +
    '.bvship-sub{font-size:13px;color:var(--muted2,#9a9a9a);letter-spacing:2px;text-transform:uppercase;margin:0 0 18px;}' +
    '.bvship-opt{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:14px 14px;margin-bottom:10px;cursor:pointer;transition:border-color .15s,background .15s;}' +
    '.bvship-opt:has(input:checked){border-color:var(--red,#e23b2e);background:rgba(226,59,46,.08);}' +
    '.bvship-opt input{accent-color:var(--red,#e23b2e);width:17px;height:17px;margin:0 4px 0 0;}' +
    '.bvship-optmain{display:flex;align-items:baseline;gap:8px;flex:1;}' +
    '.bvship-name{font-weight:700;font-size:15px;}' +
    '.bvship-price{font-weight:700;font-size:15px;color:var(--red,#e23b2e);margin-left:auto;}' +
    '.bvship-eta{flex-basis:100%;font-size:12px;color:var(--dim,#7a7a7a);padding-left:29px;}' +
    '.bvship-go{display:block;width:100%;text-align:center;margin-top:6px;cursor:pointer;border:none;font-family:inherit;}' +
    '.bvship-foot{font-size:11px;color:var(--dim,#7a7a7a);text-align:center;margin:12px 0 0;letter-spacing:.5px;}';

  var overlay, cur = {};

  function build() {
    var s = document.createElement('style'); s.textContent = STYLE; document.head.appendChild(s);
    overlay = document.createElement('div');
    overlay.className = 'bvship-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="bvship-card" role="dialog" aria-modal="true" aria-label="Choose your shipping">' +
        '<button class="bvship-x" type="button" aria-label="Close">×</button>' +
        '<h3 class="bvship-title">Choose your shipping</h3>' +
        '<p class="bvship-sub" data-sub></p>' +
        '<label class="bvship-opt"><input type="radio" name="bvship" value="std" checked>' +
          '<span class="bvship-optmain"><span class="bvship-name">Standard shipping</span><span class="bvship-price" data-std></span></span>' +
          '<span class="bvship-eta">Arrives in about 3 weeks</span></label>' +
        '<label class="bvship-opt"><input type="radio" name="bvship" value="exp">' +
          '<span class="bvship-optmain"><span class="bvship-name">Express shipping</span><span class="bvship-price" data-exp></span></span>' +
          '<span class="bvship-eta">Arrives in about 2 weeks</span></label>' +
        '<button class="bvship-go cta btn-red" type="button">Continue to checkout &rarr;</button>' +
        '<p class="bvship-foot">Ships to the UK, USA and Canada. Secure checkout on Gumroad.</p>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.bvship-x').addEventListener('click', close);
    overlay.querySelector('.bvship-go').addEventListener('click', go);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function open(btn) {
    if (!overlay) build();
    cur.std = btn.getAttribute('data-std-url');
    cur.exp = btn.getAttribute('data-exp-url');
    overlay.querySelector('[data-sub]').textContent = btn.getAttribute('data-title') || 'Paperback';
    overlay.querySelector('[data-std]').textContent = btn.getAttribute('data-std-price') || '';
    overlay.querySelector('[data-exp]').textContent = btn.getAttribute('data-exp-price') || '';
    overlay.querySelector('input[value="std"]').checked = true;
    overlay.hidden = false;
  }
  function close() { if (overlay) overlay.hidden = true; }
  function go() {
    var sel = overlay.querySelector('input[name="bvship"]:checked');
    var url = (sel && sel.value === 'exp') ? cur.exp : cur.std;
    if (url) window.location.href = url;
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.buy-paper') : null;
    if (b) { e.preventDefault(); open(b); }
  });
})();
