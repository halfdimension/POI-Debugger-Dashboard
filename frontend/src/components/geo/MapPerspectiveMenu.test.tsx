import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BuildingLayerStatus } from '../map/geo/buildingLayerManager';
import { MapPerspectiveMenu, type MapPerspectivePreferences } from './MapPerspectiveMenu';

const defaults: MapPerspectivePreferences = {
  show_3d_buildings: false,
};

const available: BuildingLayerStatus = {
  ready: true,
  sourceAvailable: true,
  effective: false,
  mode: 'off',
};

type CheckboxProps = {
  type?: string;
  disabled?: boolean;
  children?: ReactNode;
  onChange?: (event: { target: { checked: boolean } }) => void;
};

function enabledCheckbox(node: ReactNode): ReactElement<CheckboxProps> | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<CheckboxProps>;
  if (element.type === 'input' && element.props.type === 'checkbox' && !element.props.disabled) return element;
  for (const child of Children.toArray(element.props.children)) {
    const match = enabledCheckbox(child);
    if (match) return match;
  }
  return null;
}

describe('MapPerspectiveMenu', () => {
  it('is closed by default and contains only the building control', () => {
    const markup = renderToStaticMarkup(<MapPerspectiveMenu preferences={defaults} buildingStatus={available} onShow3DBuildingsChange={() => {}} />);

    expect(markup).toContain('<details class="map-perspective-menu">');
    expect(markup).not.toContain('<details class="map-perspective-menu" open=""');
    expect(markup).toContain('3D buildings off');
    expect(markup).not.toContain('type="radio"');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(1);
  });

  it('renders the saved building preference as a controlled, enabled checkbox', () => {
    const markup = renderToStaticMarkup(<MapPerspectiveMenu preferences={{
      show_3d_buildings: true,
    }} buildingStatus={{ ...available, effective: true, mode: 'provider' }} onShow3DBuildingsChange={() => {}} />);

    expect(markup).toContain('3D buildings on');
    expect(markup.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
  });

  it('reports unavailable vector data without clearing the saved preference', () => {
    const markup = renderToStaticMarkup(<MapPerspectiveMenu
      preferences={{ ...defaults, show_3d_buildings: true }}
      buildingStatus={{ ready: true, sourceAvailable: false, effective: false, mode: 'unavailable' }}
      onShow3DBuildingsChange={() => {}}
    />);

    expect(markup).toContain('Vector building data unavailable');
    expect(markup.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
  });

  it('forwards controlled checkbox changes to preference state', () => {
    const onChange = vi.fn();
    const tree = MapPerspectiveMenu({
      preferences: defaults,
      buildingStatus: available,
      onShow3DBuildingsChange: onChange,
    });

    enabledCheckbox(tree)?.props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
