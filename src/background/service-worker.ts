import { DEFAULT_SETTINGS, ExtensionSettings } from '../shared/types';

const SETTINGS_KEY = 'mtm_settings';
const CLEANUP_ALARM = 'mtm_cache_cleanup_hint';

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(SETTINGS_KEY);
  if (!existing[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60 * 24 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CLEANUP_ALARM) {
    await chrome.storage.local.set({ mtm_last_cleanup_hint: Date.now() });
  }
});

type RuntimeRequest =
  | { type: 'GET_SETTINGS' }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<ExtensionSettings> }
  | { type: 'SET_BADGE'; count: number }
  | { type: 'CLEAR_CACHE' };

chrome.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'GET_SETTINGS') {
        const stored = await chrome.storage.local.get(SETTINGS_KEY);
        const settings: ExtensionSettings = {
          ...DEFAULT_SETTINGS,
          ...(stored[SETTINGS_KEY] || {}),
        };
        sendResponse({ ok: true, settings });
        return;
      }

      if (message.type === 'UPDATE_SETTINGS') {
        const stored = await chrome.storage.local.get(SETTINGS_KEY);
        const next: ExtensionSettings = {
          ...DEFAULT_SETTINGS,
          ...(stored[SETTINGS_KEY] || {}),
          ...message.patch,
        };
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        sendResponse({ ok: true, settings: next });
        return;
      }

      if (message.type === 'SET_BADGE') {
        const tabId = sender.tab?.id;
        const text = message.count > 0 ? String(message.count) : '';
        await chrome.action.setBadgeText({ text, tabId });
        if (text) {
          await chrome.action.setBadgeBackgroundColor({ color: '#0f766e', tabId });
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'CLEAR_CACHE') {
        await chrome.storage.local.set({ mtm_cache_cleared_at: Date.now() });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});
