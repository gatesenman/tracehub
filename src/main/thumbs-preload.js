'use strict';

// Runs in the offscreen thumbnail window's page (main world, before page
// scripts). Neutralises the WebAuthn / passkey API so that background-loaded
// history pages can never trigger the native Windows Hello「选择通行密钥」
// chooser. The screenshot window never needs to authenticate.
try {
  if (window.navigator && navigator.credentials) {
    const rej = () => Promise.reject(new DOMException('disabled in thumbnail window', 'NotAllowedError'));
    navigator.credentials.get = rej;
    navigator.credentials.create = rej;
  }
  if (window.PublicKeyCredential) {
    window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
  }
} catch (e) {
  /* ignore */
}
