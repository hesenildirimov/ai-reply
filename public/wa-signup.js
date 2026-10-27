// WhatsApp Embedded Signup (https://developers.facebook.com/docs/whatsapp/embedded-signup)
(() => {
  const btn = document.getElementById('wa-connect');
  const status = document.getElementById('wa-status');
  if (!btn) return;
  let session = null;
  let code = null;

  window.fbAsyncInit = () => {
    FB.init({ appId: btn.dataset.appId, autoLogAppEvents: true, xfbml: false, version: btn.dataset.version });
  };

  window.addEventListener('message', (event) => {
    if (!/^https:\/\/([a-z]+\.)?facebook\.com$/.test(event.origin)) return;
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data && data.type === 'WA_EMBEDDED_SIGNUP') {
        if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') session = data.data;
        else if (data.event === 'CANCEL') status.textContent = 'Bağlantı ləğv edildi.';
        finish();
      }
    } catch {
      /* non-JSON messages from the SDK */
    }
  });

  async function finish() {
    if (!session || !code || !session.phone_number_id) return;
    status.textContent = 'Bağlanır...';
    const res = await fetch('/app/channels/whatsapp/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': btn.dataset.csrf },
      body: JSON.stringify({ code, waba_id: session.waba_id, phone_number_id: session.phone_number_id }),
    });
    session = code = null;
    if (res.ok) location.href = '/app/channels?m=wa_connected';
    else status.textContent = 'Bağlantı alınmadı. Yenidən cəhd edin.';
  }

  btn.addEventListener('click', () => {
    if (!window.FB) {
      status.textContent = 'Facebook SDK yüklənmədi. Reklam bloklayıcını söndürün.';
      return;
    }
    FB.login(
      (response) => {
        if (response.authResponse?.code) {
          code = response.authResponse.code;
          finish();
        } else status.textContent = 'Bağlantı ləğv edildi.';
      },
      {
        config_id: btn.dataset.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    );
  });
})();
