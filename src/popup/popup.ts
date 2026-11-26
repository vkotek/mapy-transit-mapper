import { DEFAULT_SETTINGS, ExtensionSettings } from '../shared/types';

async function loadSettings(): Promise<ExtensionSettings> {
  const resp = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as {
    ok?: boolean;
    settings?: ExtensionSettings;
  };
  return { ...DEFAULT_SETTINGS, ...(resp?.settings || {}) };
}

async function patchSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch });
}

async function initPopup(): Promise<void> {
  const settings = await loadSettings();

  const bindings: Array<{ id: string; key: keyof ExtensionSettings }> = [
    { id: 'opt-enabled', key: 'enabled' },
    { id: 'opt-nearby', key: 'showNearby' },
    { id: 'opt-curved', key: 'curvedLines' },
    { id: 'opt-travel-time', key: 'travelTimeColors' },
    { id: 'opt-labels', key: 'showStopLabels' },
  ];

  for (const b of bindings) {
    const el = document.getElementById(b.id) as HTMLInputElement | null;
    if (!el) continue;
    el.checked = Boolean(settings[b.key]);
    el.addEventListener('change', () => {
      void patchSettings({ [b.key]: el.checked });
    });
  }

  const clearBtn = document.getElementById('btn-clear-cache');
  const statusEl = document.getElementById('status-msg');
  clearBtn?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    if (statusEl) {
      statusEl.textContent = 'Stop coordinate cache cleared.';
      setTimeout(() => {
        statusEl.textContent = '';
      }, 2500);
    }
  });
}

void initPopup();
