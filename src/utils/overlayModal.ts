import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

function getVisibleFocusableElements(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

export function useModalOverlayFocus(options: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  initialFocusSelector?: string;
  onDismiss: () => void;
}): void {
  const { active, containerRef, restoreFocusRef, initialFocusSelector, onDismiss } = options;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const fallbackTrigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTimer = window.requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      if (root.contains(document.activeElement)) {
        return;
      }
      if (initialFocusSelector) {
        const preferred = root.querySelector<HTMLElement>(initialFocusSelector);
        if (preferred) {
          preferred.focus({ preventScroll: true });
          return;
        }
      }
      const focusables = getVisibleFocusableElements(root);
      if (focusables.length > 0) {
        focusables[0].focus({ preventScroll: true });
      } else {
        root.focus({ preventScroll: true });
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;

      const focusables = getVisibleFocusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!activeEl || !root.contains(activeEl) || activeEl === first) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (!activeEl || !root.contains(activeEl) || activeEl === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);

      const targetToRestore = restoreFocusRef?.current ?? fallbackTrigger;
      if (targetToRestore && document.contains(targetToRestore)) {
        window.requestAnimationFrame(() => {
          // Avoid stealing focus if another dialog (e.g. Insert Embed or Git Modal) opened
          if (document.querySelector('.modal-backdrop')) return;
          targetToRestore.focus({ preventScroll: true });
        });
      }
    };
  }, [active, containerRef, initialFocusSelector, restoreFocusRef]);
}

export function useOverlayScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;

    const savedScrollY = window.scrollY;
    const body = document.body;
    const prevPosition = body.style.position;
    const prevTop = body.style.top;
    const prevLeft = body.style.left;
    const prevRight = body.style.right;
    const prevWidth = body.style.width;
    const prevOverflow = body.style.overflow;

    body.dataset.overlayLocked = 'true';
    body.style.position = 'fixed';
    body.style.top = `-${savedScrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      delete body.dataset.overlayLocked;
      body.style.position = prevPosition;
      body.style.top = prevTop;
      body.style.left = prevLeft;
      body.style.right = prevRight;
      body.style.width = prevWidth;
      body.style.overflow = prevOverflow;
      window.scrollTo(0, savedScrollY);
    };
  }, [locked]);
}
