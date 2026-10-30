import type maplibregl from 'maplibre-gl';
import { TURN_COVERAGE_POI_HALO_LAYER_ID } from './dashboardMapLayers';

const COVERAGE_POI_SOURCE_ID = 'turn-poi-coverage-pois';
const PULSE_DURATION_MS = 1800;
const PULSE_MIN_RADIUS_PX = 9;
const PULSE_MAX_RADIUS_PX = 22;
const PULSE_MAX_OPACITY = 0.68;
const STATIC_RADIUS_PX = 13;
const STATIC_OPACITY = 0.62;

/** Animates only paint properties; coverage source data remains authoritative and unchanged. */
export class TurnCoveragePoiHalo {
  private eligiblePoiCount = 0;
  private frameId: number | null = null;
  private disposed = false;
  private readonly reducedMotionQuery: MediaQueryList | null;

  constructor(private readonly map: maplibregl.Map) {
    this.reducedMotionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reducedMotionQuery?.addEventListener('change', this.handleMotionPreferenceChange);
  }

  setEligiblePoiCount(count: number): void {
    this.eligiblePoiCount = Math.max(0, count);
    this.reconcile();
  }

  /** Reconciles after a style load, when the source and layer have been recreated. */
  syncStyle(): void {
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    this.reducedMotionQuery?.removeEventListener('change', this.handleMotionPreferenceChange);
  }

  private readonly handleMotionPreferenceChange = (): void => {
    this.reconcile();
  };

  private layerIsAvailable(): boolean {
    return Boolean(
      this.map.getSource(COVERAGE_POI_SOURCE_ID) &&
      this.map.getLayer(TURN_COVERAGE_POI_HALO_LAYER_ID),
    );
  }

  private reconcile(): void {
    this.stopAnimation();
    if (this.disposed || this.eligiblePoiCount === 0 || !this.layerIsAvailable()) return;

    if (this.reducedMotionQuery?.matches) {
      this.setPaint(STATIC_RADIUS_PX, STATIC_OPACITY);
      return;
    }
    this.frameId = window.requestAnimationFrame(this.animate);
  }

  private readonly animate = (timestamp: number): void => {
    this.frameId = null;
    if (this.disposed || this.eligiblePoiCount === 0 || !this.layerIsAvailable()) return;

    const progress = (timestamp % PULSE_DURATION_MS) / PULSE_DURATION_MS;
    const radius = PULSE_MIN_RADIUS_PX + (PULSE_MAX_RADIUS_PX - PULSE_MIN_RADIUS_PX) * progress;
    const opacity = PULSE_MAX_OPACITY * Math.pow(1 - progress, 1.35);
    if (!this.setPaint(radius, opacity)) return;
    this.frameId = window.requestAnimationFrame(this.animate);
  };

  private setPaint(radius: number, opacity: number): boolean {
    try {
      this.map.setPaintProperty(TURN_COVERAGE_POI_HALO_LAYER_ID, 'circle-radius', radius);
      this.map.setPaintProperty(TURN_COVERAGE_POI_HALO_LAYER_ID, 'circle-stroke-opacity', opacity);
      return true;
    } catch {
      // A style can be replaced between lifecycle callbacks. The next
      // style.load reconciliation will restart the animation if appropriate.
      this.stopAnimation();
      return false;
    }
  }

  private stopAnimation(): void {
    if (this.frameId === null) return;
    window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }
}
