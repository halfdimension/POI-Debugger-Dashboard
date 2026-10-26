import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

export const ANALYSIS_PANEL_MIN_HEIGHT = 190;
export const MAP_WORKSPACE_MIN_HEIGHT = 180;
export const ANALYSIS_PANEL_KEYBOARD_STEP = 24;

export type VerticalPanelBounds = { minimum: number; maximum: number };

export function verticalPanelBounds(
  workspaceHeight: number,
  panelMinimum = ANALYSIS_PANEL_MIN_HEIGHT,
  mapMinimum = MAP_WORKSPACE_MIN_HEIGHT,
): VerticalPanelBounds {
  const safeWorkspaceHeight = Number.isFinite(workspaceHeight) ? Math.max(0, workspaceHeight) : 0;
  const safeMapMinimum = Number.isFinite(mapMinimum) ? Math.max(0, mapMinimum) : 0;
  const maximum = Math.max(0, Math.floor(safeWorkspaceHeight - safeMapMinimum));
  const requestedMinimum = Number.isFinite(panelMinimum) ? Math.max(0, panelMinimum) : 0;
  return { minimum: Math.min(requestedMinimum, maximum), maximum };
}

export function renderableVerticalPanelHeight(
  preferredHeight: number,
  workspaceHeight: number,
  panelMinimum = ANALYSIS_PANEL_MIN_HEIGHT,
  mapMinimum = MAP_WORKSPACE_MIN_HEIGHT,
): number {
  const bounds = verticalPanelBounds(workspaceHeight, panelMinimum, mapMinimum);
  const safePreferred = Number.isFinite(preferredHeight) ? preferredHeight : bounds.minimum;
  return Math.max(bounds.minimum, Math.min(bounds.maximum, safePreferred));
}

export function useVerticalPanelResize({
  workspaceRef,
  panelRef,
  preferredHeight,
  onPreferredHeightChange,
  disabled = false,
}: {
  workspaceRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  preferredHeight: number;
  onPreferredHeightChange: (height: number) => void;
  disabled?: boolean;
}) {
  const preferredHeightRef = useRef(preferredHeight);
  const liveHeightRef = useRef(preferredHeight);
  const boundsRef = useRef<VerticalPanelBounds>({
    minimum: ANALYSIS_PANEL_MIN_HEIGHT,
    maximum: Math.max(ANALYSIS_PANEL_MIN_HEIGHT, preferredHeight),
  });
  const dragStartRef = useRef<{ pointerId: number; clientY: number; height: number } | null>(null);
  const [liveHeight, setLiveHeight] = useState(preferredHeight);
  const [bounds, setBounds] = useState(boundsRef.current);
  const [resizing, setResizing] = useState(false);

  const applyMeasuredHeight = useCallback((requestedHeight: number) => {
    const workspaceHeight = workspaceRef.current?.getBoundingClientRect().height ?? 0;
    if (workspaceHeight <= 0) {
      const fallbackHeight = Math.max(ANALYSIS_PANEL_MIN_HEIGHT, requestedHeight);
      const fallbackBounds = {
        minimum: ANALYSIS_PANEL_MIN_HEIGHT,
        maximum: fallbackHeight,
      };
      boundsRef.current = fallbackBounds;
      liveHeightRef.current = fallbackHeight;
      setBounds(fallbackBounds);
      setLiveHeight(fallbackHeight);
      return fallbackHeight;
    }

    const nextBounds = verticalPanelBounds(workspaceHeight);
    const nextHeight = renderableVerticalPanelHeight(requestedHeight, workspaceHeight);
    boundsRef.current = nextBounds;
    liveHeightRef.current = nextHeight;
    setBounds(nextBounds);
    setLiveHeight(nextHeight);
    return nextHeight;
  }, [workspaceRef]);

  useEffect(() => {
    preferredHeightRef.current = preferredHeight;
    if (!dragStartRef.current) applyMeasuredHeight(preferredHeight);
  }, [applyMeasuredHeight, preferredHeight]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || typeof ResizeObserver === 'undefined') return;
    const updateForWorkspace = () => {
      if (!dragStartRef.current) applyMeasuredHeight(preferredHeightRef.current);
    };
    const observer = new ResizeObserver(updateForWorkspace);
    observer.observe(workspace);
    window.addEventListener('resize', updateForWorkspace);
    updateForWorkspace();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateForWorkspace);
      document.body.classList.remove('is-resizing-analysis-panel');
    };
  }, [applyMeasuredHeight, workspaceRef]);

  const commitHeight = useCallback((requestedHeight: number) => {
    const nextHeight = applyMeasuredHeight(requestedHeight);
    preferredHeightRef.current = nextHeight;
    onPreferredHeightChange(nextHeight);
  }, [applyMeasuredHeight, onPreferredHeightChange]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    const renderedHeight = panelRef.current?.getBoundingClientRect().height || liveHeightRef.current;
    applyMeasuredHeight(renderedHeight);
    dragStartRef.current = { pointerId: event.pointerId, clientY: event.clientY, height: renderedHeight };
    setResizing(true);
    document.body.classList.add('is-resizing-analysis-panel');
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }, [applyMeasuredHeight, disabled, panelRef]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    applyMeasuredHeight(start.height + start.clientY - event.clientY);
    event.preventDefault();
  }, [applyMeasuredHeight]);

  const finishPointerResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
    document.body.classList.remove('is-resizing-analysis-panel');
    commitHeight(liveHeightRef.current);
  }, [commitHeight]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    commitHeight(liveHeightRef.current + (event.key === 'ArrowUp' ? ANALYSIS_PANEL_KEYBOARD_STEP : -ANALYSIS_PANEL_KEYBOARD_STEP));
  }, [commitHeight, disabled]);

  return {
    liveHeight,
    minimumHeight: bounds.minimum,
    maximumHeight: bounds.maximum,
    resizing,
    resizeHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishPointerResize,
      onPointerCancel: finishPointerResize,
      onKeyDown,
    },
  };
}
