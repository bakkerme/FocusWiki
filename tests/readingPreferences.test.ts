import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READING_PREFERENCES,
  READING_PREFERENCES_STORAGE_KEY,
  loadReadingPreferences,
  saveReadingPreferences
} from '../src/utils/readingPreferences.js';

describe('Reading presentation preferences persistence and recovery', () => {
  it('returns defaults when storage is absent, empty, corrupt, wrong version, or blocked', () => {
    expect(loadReadingPreferences(null)).toEqual(DEFAULT_READING_PREFERENCES);

    const emptyStore = { getItem: () => null };
    expect(loadReadingPreferences(emptyStore)).toEqual(DEFAULT_READING_PREFERENCES);

    const corruptStore = { getItem: () => '{not valid json' };
    expect(loadReadingPreferences(corruptStore)).toEqual(DEFAULT_READING_PREFERENCES);

    const wrongVersionStore = {
      getItem: () => JSON.stringify({ version: 99, textSize: 'large', pageWidth: 'wide' })
    };
    expect(loadReadingPreferences(wrongVersionStore)).toEqual(DEFAULT_READING_PREFERENCES);

    const partialInvalidStore = {
      getItem: () => JSON.stringify({ version: 1, textSize: 'huge', pageWidth: 'narrow' })
    };
    expect(loadReadingPreferences(partialInvalidStore)).toEqual({
      textSize: 'standard',
      pageWidth: 'narrow'
    });

    const throwingStore = {
      getItem: () => {
        throw new DOMException('Blocked by private browsing', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Blocked by private browsing', 'SecurityError');
      }
    };
    expect(loadReadingPreferences(throwingStore)).toEqual(DEFAULT_READING_PREFERENCES);
    expect(saveReadingPreferences({ textSize: 'large', pageWidth: 'wide' }, throwingStore)).toBe(
      false
    );
  });

  it('persists and reloads valid versioned presets cleanly', () => {
    const map = new Map<string, string>();
    const memStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      }
    };

    const ok = saveReadingPreferences({ textSize: 'large', pageWidth: 'narrow' }, memStorage);
    expect(ok).toBe(true);
    expect(READING_PREFERENCES_STORAGE_KEY).toBe('focus:reading-preferences:v1');
    const saved = JSON.parse(map.get(READING_PREFERENCES_STORAGE_KEY) || '{}');
    expect(saved).toEqual({
      version: 1,
      textSize: 'large',
      pageWidth: 'narrow'
    });
    expect(loadReadingPreferences(memStorage)).toEqual({
      textSize: 'large',
      pageWidth: 'narrow'
    });

    const legacyOnlyStore = {
      getItem: (k: string) =>
        k === 'cairn:reading-preferences:v1'
          ? JSON.stringify({ version: 1, textSize: 'small', pageWidth: 'wide' })
          : null
    };
    expect(loadReadingPreferences(legacyOnlyStore)).toEqual({
      textSize: 'small',
      pageWidth: 'wide'
    });
  });
});
