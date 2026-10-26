import { describe, expect, it, vi } from 'vitest';
import { makePoiPopupDraggable, poiPopupHtml } from './poiPopup';

describe('poiPopupHtml', () => {
  it('preserves preferred property ordering and popup CSS classes', () => {
    const html = poiPopupHtml({
      extra: 'last',
      landmark_type: 'restaurant',
      name: 'Cafe',
      mappls_poi_id: 'poi-1',
      empty: '',
    });

    expect(html).toContain('class="poi-popup"');
    expect(html).toContain('class="poi-popup-title">Cafe</div>');
    expect(html.indexOf('<strong>name</strong>')).toBeLessThan(html.indexOf('<strong>mappls_poi_id</strong>'));
    expect(html.indexOf('<strong>mappls_poi_id</strong>')).toBeLessThan(html.indexOf('<strong>landmark_type</strong>'));
    expect(html.indexOf('<strong>landmark_type</strong>')).toBeLessThan(html.indexOf('<strong>extra</strong>'));
    expect(html).not.toContain('<strong>empty</strong>');
  });

  it('escapes the title, property names, and property values', () => {
    const html = poiPopupHtml({
      name: '<img src=x onerror="alert(1)">',
      '<script>': `& < > " '`,
    });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; &lt; &gt; &quot; &#039;');
  });

  it('keeps the existing fallback title for missing properties', () => {
    expect(poiPopupHtml(null)).toBe(
      '<div class="poi-popup"><div class="poi-popup-title">POI</div></div>',
    );
  });
});

describe('makePoiPopupDraggable', () => {
  it('captures pointer dragging, clamps the popup, suppresses clicks, and cleans up listeners', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const classList = { add: vi.fn(), remove: vi.fn() };
    const style = { translate: '' };
    const title = {
      addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn().mockReturnValue(true),
      releasePointerCapture: vi.fn(),
    };
    const translatedOffset = () => Number(style.translate.split('px')[0]) || 0;
    const popupElement = {
      querySelector: vi.fn().mockReturnValue(title),
      classList,
      style,
      getBoundingClientRect: () => ({
        left: 100 + translatedOffset(),
        right: 200 + translatedOffset(),
        top: 100,
        bottom: 150,
        width: 100,
        height: 50,
      }),
    };
    const popup = { getElement: () => popupElement };
    const map = {
      getContainer: () => ({
        getBoundingClientRect: () => ({
          left: 0,
          right: 300,
          top: 0,
          bottom: 200,
          width: 300,
          height: 200,
        }),
      }),
    };
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    const cleanup = makePoiPopupDraggable(popup as never, map as never);
    listeners.get('pointerdown')?.({
      isPrimary: true,
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
      preventDefault,
      stopPropagation,
    });
    listeners.get('pointermove')?.({
      pointerId: 7,
      clientX: 160,
      clientY: 10,
      preventDefault,
      stopPropagation,
    });

    expect(style.translate).toBe('96px 0px');
    expect(title.setPointerCapture).toHaveBeenCalledWith(7);
    expect(classList.add).toHaveBeenCalledWith('is-dragging');

    listeners.get('click')?.({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();

    listeners.get('pointerup')?.({ pointerId: 7, preventDefault, stopPropagation });
    expect(title.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(classList.remove).toHaveBeenCalledWith('is-dragging');

    cleanup();
    expect(listeners.size).toBe(0);
    expect(title.removeEventListener).toHaveBeenCalledTimes(6);
  });
});
