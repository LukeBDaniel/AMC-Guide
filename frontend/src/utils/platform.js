import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';

// True inside the iOS app (Capacitor's WKWebView), false on the website.
export const isNative = Capacitor.isNativePlatform();

// The website opens ticket links in a new tab; the app shows them in an in-app Safari sheet.
export function openLink(url) {
  if (!url) return;
  if (isNative) {
    Browser.open({ url });
  } else {
    window.open(url, '_blank');
  }
}
